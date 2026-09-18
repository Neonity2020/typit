import { syntaxTree } from '@codemirror/language'
import { HighlightStyle } from '@codemirror/language'
import { RangeSet, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * Typora / Obsidian 式实时预览：
 * 缓冲区始终是 Markdown 源文本，基于 lezer 语法树叠加装饰——
 * 光标附近的语法符号保持可见，移开后隐藏并渲染样式。
 */

// 不用 defaultHighlightStyle：它给标题加下划线，与 Typora 风格冲突。
// 代码配色通过 CSS 变量读取，自动适配深浅色主题。
export const typitHighlightStyle = HighlightStyle.define([
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className], color: 'var(--syn-type)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--syn-variable)' },
])

const hideMark = Decoration.replace({})
const quoteLine = Decoration.line({ class: 'typit-quote-line' })
const codeLine = Decoration.line({ class: 'typit-code-line' })

/** 光标/选区是否落在节点范围内（含 1 字符余量）——落在其中时显示源语法 */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to + 1 && range.to >= from - 1) return true
  }
  return false
}

interface Built {
  decorations: DecorationSet
  hidden: DecorationSet
}

/** 只依赖这两项，因此本函数可以在没有 DOM 的环境下直接测试 */
export interface DecorationInput {
  state: EditorState
  visibleRanges: readonly { from: number; to: number }[]
}

export function buildDecorations(view: DecorationInput): Built {
  const state = view.state
  const all: Range<Decoration>[] = []
  const hidden: Range<Decoration>[] = []

  const mark = (from: number, to: number, cls: string) => {
    if (to > from) all.push(Decoration.mark({ class: cls }).range(from, to))
  }
  // 光标不在父节点内时隐藏语法标记（这些区域同时是原子区，光标左右键会跳过）
  const hide = (from: number, to: number) => {
    if (to > from) {
      const range = hideMark.range(from, to)
      all.push(range)
      hidden.push(range)
    }
  }
  const line = (pos: number, deco: Decoration) => {
    all.push(deco.range(pos))
  }

  const tree = syntaxTree(state)

  // 只遍历可视区。整树遍历是 O(文档长度)，而本函数在每次按键和光标移动时都会重跑。
  // 注意 iterate 对跨越可视区的节点（长引用、长代码块）交出的是完整范围，
  // 所以整块的行装饰还要按可视区再裁一次，否则开销只是换了个地方留着。
  for (const range of view.visibleRanges) {
    const blockLines = (from: number, to: number, deco: Decoration) => {
      let pos = Math.max(from, range.from)
      const end = Math.min(to, range.to)
      while (pos <= end) {
        const lineObj = state.doc.lineAt(pos)
        line(lineObj.from, deco)
        pos = lineObj.to + 1
      }
    }

    tree.iterate({
      from: range.from,
      to: range.to,
      enter: node => {
        const { name } = node

        // 标题：整行放大加粗；光标不在行内时隐藏 "#" 标记
        const heading = /^ATXHeading([1-6])$/.exec(name)
        if (heading) {
          mark(node.from, node.to, `typit-heading typit-h${heading[1]}`)
          return
        }
        if (name === 'HeaderMark') {
          const parent = node.node.parent
          if (parent && /^ATXHeading[1-6]$/.test(parent.name) && !selectionTouches(state, parent.from, parent.to)) {
            hide(node.from, node.to)
          }
          return
        }

        if (name === 'StrongEmphasis') {
          mark(node.from, node.to, 'typit-strong')
          return
        }
        if (name === 'Emphasis') {
          mark(node.from, node.to, 'typit-em')
          return
        }
        if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          const parent = node.node.parent
          if (
            parent &&
            (parent.name === 'Emphasis' || parent.name === 'StrongEmphasis' || parent.name === 'Strikethrough') &&
            !selectionTouches(state, parent.from, parent.to)
          ) {
            hide(node.from, node.to)
          }
          return
        }
        if (name === 'Strikethrough') {
          mark(node.from, node.to, 'typit-strike')
          return
        }

        if (name === 'InlineCode') {
          mark(node.from, node.to, 'typit-inline-code')
          return
        }

        // 行内 / 引用式链接：光标不在时只留链接文字，隐藏 [ ] ( ) 与 URL
        if (name === 'Link') {
          mark(node.from, node.to, 'typit-link')
          if (!selectionTouches(state, node.from, node.to)) {
            const marks = node.node.getChildren('LinkMark')
            if (marks.length >= 3) {
              hide(marks[0].from, marks[0].to)
              hide(marks[1].from, node.to)
            } else {
              for (const m of marks) hide(m.from, m.to)
            }
          }
          return
        }
        if (name === 'Image') {
          if (!selectionTouches(state, node.from, node.to)) {
            const marks = node.node.getChildren('LinkMark')
            if (marks.length >= 3) {
              hide(marks[0].from, marks[0].to)
              hide(marks[1].from, node.to)
            } else {
              for (const m of marks) hide(m.from, m.to)
            }
          }
          return
        }

        // 引用块：逐行加左侧竖线并弱化；光标不在块内时隐藏 ">" 标记
        if (name === 'Blockquote') {
          blockLines(node.from, node.to, quoteLine)
          return
        }
        if (name === 'QuoteMark') {
          const parent = node.node.parent
          if (parent && parent.name === 'Blockquote' && !selectionTouches(state, parent.from, parent.to)) {
            hide(node.from, node.to)
          }
          return
        }

        // 围栏 / 缩进代码块：整块等宽背景；光标不在块内时隐藏围栏 ``` 和语言名
        if (name === 'FencedCode' || name === 'CodeBlock') {
          blockLines(node.from, node.to, codeLine)
          return
        }
        if (name === 'CodeMark' || name === 'CodeInfo') {
          const parent = node.node.parent
          if (parent && (parent.name === 'FencedCode' || parent.name === 'InlineCode') && !selectionTouches(state, parent.from, parent.to)) {
            hide(node.from, node.to)
          }
          return
        }
      },
    })
  }

  return {
    decorations: RangeSet.of(all, true),
    hidden: RangeSet.of(hidden, true),
  }
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    hiddenMarks: DecorationSet

    constructor(view: EditorView) {
      const built = buildDecorations(view)
      this.decorations = built.decorations
      this.hiddenMarks = built.hidden
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        const built = buildDecorations(update.view)
        this.decorations = built.decorations
        this.hiddenMarks = built.hidden
      }
    }
  },
  {
    decorations: v => v.decorations,
    provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.hiddenMarks ?? Decoration.none),
  },
)

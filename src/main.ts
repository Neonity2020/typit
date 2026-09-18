import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { drawSelection, EditorView, highlightSpecialChars, keymap } from '@codemirror/view'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save } from '@tauri-apps/plugin-dialog'
import { livePreview, typitHighlightStyle } from './livepreview'
import './style.css'

const DEMO_DOC = [
  '# Typit',
  '',
  '一个追求**低内存**的 Markdown 笔记。把光标移开后，`#`、`**` 这类语法符号会自动隐藏。',
  '',
  '## 实时预览',
  '',
  '- 行内 `code`、*斜体*、**粗体**、~~删除线~~',
  '- [链接](https://example.com) 渲染成链接样式',
  '',
  '> 引用块——像 Typora 一样单栏编辑',
  '',
  '```rust',
  'fn main() {',
  '    println!("Hello Typit");',
  '}',
  '```',
  '',
  'Cmd+O 打开文件，Cmd+S 保存。',
].join('\n')

let filePath: string | null = null
let dirty = false

const pathEl = document.getElementById('doc-path') as HTMLElement
const dirtyEl = document.getElementById('doc-dirty') as HTMLElement

function displayName(): string {
  return filePath ? filePath.split('/').pop()! : '未命名.md'
}

async function refreshChrome(): Promise<void> {
  pathEl.textContent = filePath ?? '未命名.md'
  dirtyEl.textContent = dirty ? '● 未保存' : ''
  try {
    await getCurrentWindow().setTitle(`${dirty ? '● ' : ''}${displayName()} — Typit`)
  } catch {
    // 在纯浏览器里开发时没有 Tauri API，忽略即可
  }
}

async function saveDoc(): Promise<boolean> {
  let target = filePath
  if (!target) {
    const chosen = await save({
      defaultPath: '未命名.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (!chosen) return false
    target = chosen
  }
  try {
    await invoke('write_file', { path: target, contents: view.state.doc.toString() })
    filePath = target
    dirty = false
    await refreshChrome()
    return true
  } catch (e) {
    console.error('保存失败', e)
    return false
  }
}

async function openDoc(): Promise<boolean> {
  const chosen = await open({
    multiple: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  })
  if (typeof chosen !== 'string') return false
  try {
    const contents = await invoke<string>('read_file', { path: chosen })
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: contents } })
    filePath = chosen
    dirty = false
    await refreshChrome()
    view.focus()
    return true
  } catch (e) {
    console.error('打开失败', e)
    return false
  }
}

const view = new EditorView({
  parent: document.getElementById('editor')!,
  state: EditorState.create({
    doc: DEMO_DOC,
    extensions: [
      history(),
      drawSelection(),
      highlightSpecialChars(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(typitHighlightStyle, { fallback: true }),
      livePreview,
      EditorView.lineWrapping,
      keymap.of([
        { key: 'Mod-s', run: () => { void saveDoc(); return true } },
        { key: 'Mod-o', run: () => { void openDoc(); return true } },
        ...markdownKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !dirty) {
          dirty = true
          void refreshChrome()
        }
      }),
    ],
  }),
})

window.addEventListener('beforeunload', event => {
  if (dirty) {
    event.preventDefault()
    event.returnValue = ''
  }
})

view.focus()
void refreshChrome()

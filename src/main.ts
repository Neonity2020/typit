import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightSpecialChars, keymap } from '@codemirror/view'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message, open, save } from '@tauri-apps/plugin-dialog'
import { linkUrlAt, livePreview, typitHighlightStyle } from './livepreview'
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
const errorEl = document.getElementById('doc-error') as HTMLElement

function displayName(): string {
  return filePath ? filePath.split('/').pop()! : '未命名.md'
}

/** Tauri 命令的失败值通常是 Rust 侧的字符串 */
function describeError(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  return String(e)
}

let errorTimer: number | undefined

/**
 * 在状态栏显示一条错误并自动消失。打包后用户没有 devtools，
 * 只写 console.error 等于什么提示都没有。
 */
function showError(message: string, cause: unknown): void {
  console.error(message, cause)
  errorEl.textContent = message
  window.clearTimeout(errorTimer)
  errorTimer = window.setTimeout(() => {
    errorEl.textContent = ''
  }, 6000)
}

/** 在系统默认浏览器中打开链接；协议不被允许时提示而不是静默失败 */
async function openExternal(url: string): Promise<void> {
  try {
    await invoke('open_url', { url })
  } catch (e) {
    showError(`打开链接失败：${describeError(e)}`, e)
  }
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
    showError(`保存失败：${describeError(e)}`, e)
    return false
  }
}

// 桌面端 message() 会把点击的按钮映射回标签本身（见 tauri-plugin-dialog 的 desktop.rs）
const SAVE_LABEL = '保存'
const DISCARD_LABEL = '不保存'
const CANCEL_LABEL = '取消'

/**
 * 有未保存改动时询问。返回 true 表示可以继续（已保存或用户选择放弃改动），
 * false 表示应当中止——用户取消，或保存失败/另存为被取消。
 */
async function confirmUnsaved(): Promise<boolean> {
  const choice = await message(`「${displayName()}」有未保存的改动。`, {
    title: '未保存的改动',
    kind: 'warning',
    buttons: { yes: SAVE_LABEL, no: DISCARD_LABEL, cancel: CANCEL_LABEL },
  })
  if (choice === SAVE_LABEL) return saveDoc()
  if (choice === DISCARD_LABEL) return true
  // 取消，或出现意料之外的返回值——宁可什么都不做，也不能丢掉改动
  return false
}

async function openDoc(): Promise<boolean> {
  if (dirty && !(await confirmUnsaved())) return false
  const chosen = await open({
    multiple: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  })
  if (typeof chosen !== 'string') return false
  try {
    const contents = await invoke<string>('read_file', { path: chosen })
    // 重建状态而不是替换文档：这样撤销历史被清空，Cmd+Z 不会把上一个文件的内容
    // 带回缓冲区（否则再保存就会把旧内容写进刚打开的文件）。顺带把光标与滚动归零。
    view.setState(createEditorState(contents))
    filePath = chosen
    dirty = false
    await refreshChrome()
    view.focus()
    return true
  } catch (e) {
    showError(`打开失败：${describeError(e)}`, e)
    return false
  }
}

// 扩展列表在初始状态和打开文件时共用——打开文件要重建整个 EditorState
// （见 openDoc），不能只替换文档内容。
const editorExtensions: Extension[] = [
  history(),
  drawSelection(),
  highlightSpecialChars(),
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  syntaxHighlighting(typitHighlightStyle, { fallback: true }),
  livePreview,
  EditorView.lineWrapping,
  // 点击链接交给系统默认浏览器。用 mousedown 而非 click：光标定位发生在 mousedown 阶段，
  // 要在这里拦下，否则打开链接的同时光标还会跳进链接、把源码暴露出来。
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return false
      const url = linkUrlAt(view.state, pos)
      if (!url) return false
      event.preventDefault()
      void openExternal(url)
      return true
    },
  }),
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
]

function createEditorState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: editorExtensions })
}

const view = new EditorView({
  parent: document.getElementById('editor')!,
  state: createEditorState(DEMO_DOC),
})

// 关窗走原生流程：一旦注册了 onCloseRequested，Tauri 侧就不再自动关窗
// （manager/window.rs 里 has_js_listener 为真时会 prevent_close），
// 改由这里决定——未保存就先确认，确认通过才让 API 自己关掉窗口。
// API 内部用 destroy() 关窗，所以需要 core:window:allow-destroy 权限。
void getCurrentWindow().onCloseRequested(async event => {
  if (!dirty) return
  if (!(await confirmUnsaved())) event.preventDefault()
})

// Cmd+Q / 菜单里的"退出"：默认菜单项走 macOS 原生 terminate:，不经过 Tauri，
// 所以 Rust 侧把它换成了自定义菜单项并转发成这个事件（见 src-tauri/src/lib.rs），
// 确认通过后才调用 quit_app 真正退出。
void listen('quit-requested', async () => {
  if (!dirty || (await confirmUnsaved())) await invoke('quit_app')
})

view.focus()
void refreshChrome()

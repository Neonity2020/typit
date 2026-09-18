# Typit

一个追求低内存占用的 Markdown 笔记应用，单栏实时预览（Typora / Obsidian Live Preview 风格），仅支持 macOS。

## 技术栈

- **壳**：Tauri 2（Rust + 系统 WKWebView），空载内存远低于 Electron
- **编辑器**：CodeMirror 6 + 自研 live-preview 装饰层（`src/livepreview.ts`）
- **前端**：Vite + TypeScript，无重型框架
- **存储**：磁盘纯 `.md` 文件，无数据库
- **对话框**：`tauri-plugin-dialog`（系统原生打开/保存面板）

## 实时预览原理

缓冲区始终是 Markdown 源文本。装饰层遍历 lezer 语法树叠加 decoration：

- 标题放大、粗斜体、行内代码、删除线、链接、引用块、围栏代码块即时渲染
- 光标所在节点附近的语法符号（`#`、`**`、`[ ]`、` ``` ` 等）自动显示，移开后隐藏
- 隐藏区域是原子区（`EditorView.atomicRanges`），左右方向键会跳过
- 代码块语法高亮走 `@codemirror/language-data` 懒加载，只在打开对应语言时才载入解析器

## 开发

```bash
npm install
npm run tauri dev    # 开发（自动起 vite + 编译 Rust）
npm run tauri build  # 打包 .app / .dmg
```

- `Cmd+O` 打开文件，`Cmd+S` 保存（另存为弹出系统面板）
- 标题栏与底部状态栏显示文件路径与未保存状态

## 结构

```
src/                  前端
  main.ts             编辑器装配、打开/保存流程
  livepreview.ts      live-preview 装饰层 + 配色（核心）
  style.css           主题（深浅色自适应，代码配色用 CSS 变量）
src-tauri/            Rust 壳
  src/lib.rs          read_file / write_file 命令
  capabilities/       权限（core + dialog）
```

## 路线图

- [ ] 列表符号与任务复选框的装饰渲染
- [ ] 图片内联 widget 渲染
- [ ] 文件树侧栏 + 目录监听（`notify`）
- [ ] 全文搜索（Rust 侧 `tantivy` 或 grep）
- [ ] 导出 HTML / PDF
- [ ] 非法 UTF-8 文件的容错读取

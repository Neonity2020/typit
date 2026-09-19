# AGENTS.md — Typit

低内存 Markdown 笔记，单栏实时预览（Typora / Obsidian Live Preview 风格）。**仅支持 macOS**。

## 常用命令

```bash
bun install            # 安装依赖（只用 bun，不要用 npm/pnpm/yarn）
bun run tauri dev      # 开发：起 vite + 编译 Rust + 打开应用窗口
bun run build          # 前端类型检查 + 构建（tsc && vite build）
bun run tauri build    # 打包 .app / .dmg
cargo check            # 只查 Rust（在 src-tauri/ 下执行）
```

- 无测试框架。验证 = `bun run build` 全绿 + `cargo check` 全绿；改了 UI 再跑 `bun run tauri dev` 实际看窗口。
- vite dev 固定端口 5173（strictPort）。

## 架构

```
src/
  main.ts          应用入口：编辑器装配、Cmd+O/Cmd+S、未保存状态（badge + 窗口标题）
  livepreview.ts   ★ 核心：live-preview 装饰层 + 自定义 HighlightStyle
  style.css        主题（深浅色跟随系统，全部走 CSS 变量）
src-tauri/
  src/lib.rs       Rust 命令：read_file / write_file（仅此两个）
  capabilities/    Tauri 权限：core:default + dialog:default
  tauri.conf.json  窗口/打包配置；beforeDevCommand 用 bun run
```

前端无框架（原生 TS + CM6）；文件存磁盘纯 `.md`，无数据库；文件对话框走 `tauri-plugin-dialog`，实际文件 IO 走自定义 Rust 命令。

## 核心设计约束（改代码前必读）

1. **缓冲区永远是 Markdown 源文本**。所见即所得只通过 decoration 叠加实现（`src/livepreview.ts`），绝不把文档转成富文本树。这是低内存与零往返保真问题的根基，任何功能都不得破坏它。
2. **内存是第一约束**：
   - 语法高亮按语言懒加载（`@codemirror/language-data`），不要在启动时全量 import 重型库；
   - 引入新依赖前先问"这个能不能不做/能不能放 Rust 侧"；
   - Rust release 已配 LTO + `opt-level = "s"` + strip，保持。
3. **装饰层机制**：光标所在节点（±1 字符容差，`selectionTouches`）内的语法符号保持可见，其余隐藏；隐藏用的 `Decoration.replace` 同时注册进 `EditorView.atomicRanges`，让方向键跳过。新增语法渲染时两处都要挂。
4. **不要用 `defaultHighlightStyle`**：它给标题加下划线（text-decoration 从内层 span 传播），与 Typora 风格冲突。用 `livepreview.ts` 导出的 `typitHighlightStyle`；代码配色通过 `--syn-*` CSS 变量读取以适配深浅色。
5. **lezer 节点名以 `@lezer/markdown` 实际导出为准**（已核对：`ATXHeading1-6`、`HeaderMark`、`EmphasisMark`、`StrikethroughMark`、`CodeMark`、`CodeInfo`、`QuoteMark`、`LinkMark`、`FencedCode` 等）。新增语法前先 grep node_modules 确认。

## 约定

- 代码注释与 UI 文案用中文；标识符用英文。
- TypeScript strict + `noUnusedLocals`/`noUnusedParameters` 全开，保持零告警通过。
- `bun.lock` 需要提交；`node_modules/`、`dist/`、`src-tauri/target/` 已忽略。
- 路线图（列表装饰 → 图片 widget → 文件树 + notify → 全文搜索 → 导出）见 README。

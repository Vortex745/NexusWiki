# ADR 0001: UI 组件库整体迁移到 TDesign React

- 日期：2026-11-06
- 状态：已实施；其中「不引入 @tdesign-react/chat」与「保留 react-markdown 作为内容渲染器」两条裁决已被 [ADR 0002](0002-tdesign-chat-adoption.md)（2026-11-07）推翻

## 背景

项目渲染层原先使用 antd v6.7.0 作为组件库，Nova/oklch 令牌作为主题单一事实源，Lucide 作为图标。为让桌面端视觉体系统一，需要把全部可见 UI 换成 TDesign React。

`lib/antd-theme.ts` 存在的唯一原因，是 antd 的 `fast-color` 解析不了 oklch 字符串，必须在运行时把 CSS 计算值转成 sRGB 再喂给 `ConfigProvider`。这个桥约 80 行，且让首帧主题应用依赖一次 React 渲染。

## 决定

1. **组件库**：全部可见控件与图标来自 `tdesign-react` 1.18.6 与 `tdesign-icons-react` 0.6.12。移除 antd、Lucide、shadcn、`cn` 以及两个未使用的预留库。
2. **样式引入**：采用深路径按需 `tdesign-react/es/<component>`。根 barrel 会通过 70+ 条顶层 `style/css.js` 引入全量 617.48 KB CSS，Vite 不对 CSS 做摇树；深路径让每个组件只带自己的样式。
3. **主题**：删掉 `lib/antd-theme.ts` 与 JS 主题桥。改由 `lib/td-tokens.css` 用 `color-mix(in oklch, var(--primary) N%, white/black)` 派生 TDesign 十级品牌/错误色阶，并把语义别名映射到 Nova 变量。明暗两套随 `.dark` 类即时切换，无 React 重渲染。
4. **聊天区**：用 TDesign 基础组件与图标重建四类时间线行，保留 `react-markdown` 作为内容渲染器，保留 IPC 增量协议、zustand 分平面 store 与钉底滚动单例。
5. **验收契约**：在自控 DOM 节点上加 `data-test` 锚点，不依赖 `.t-*` 内部结构。

## 为什么拒绝 `@tdesign-react/chat`

它是 `@tdesign/web-components-chat` 的 React 包装，内部 `reactify` 为每个 Web Component 用 `createRoot` 挂独立 React root。传递依赖 omi 7.7.14、cherry-markdown 0.11.8、zod、`@json-render/core` 合计 61.2 MB。`ChatMarkdown` 默认 `html: true`，会打开 `HANDOFF.md` 已记录关闭的 XSS 面。`useChat` 绑定自有 SSE endpoint，与项目 `chat:chunk` / `chat:stream` / `chat:task-activity` 的 Electron IPC 增量协议不兼容。整套替换会丢掉 O(1) 分平面流式渲染与已验证的 0.148 s 性能基线。

## 为什么保留 Tailwind 与 react-markdown

两者都不是组件库：Tailwind 是布局原子类，TDesign 不提供等价物；`react-markdown` 是内容渲染引擎，默认不渲染 raw HTML，是已验证的安全边界。移除它们需要全站布局重写且无功能收益。

## 后果

- CSS 从 41.39 KB 增至 181.90 KB（深路径按需，非全量 658.9 KB）；JS 从 2121 KB 降至 1633.30 KB，总体积净减约 347 KB。
- `@layer base` 的全局 `*` 收敛到 `.app-ui :where(*)`，避免 TDesign 未分层 CSS 与 Portal 浮层吃到 Nova 的 border/ring。
- `react-19-adapter` 必须是 `main.tsx` 第一条副作用 import，否则命令式浮层在 React 19 下失效。
- 13 个 CDP 探针经 codemod 从 `.ant-*` 选择器批量映射到 `data-test` / `.t-*`。
- 87 个主进程测试、`typecheck`、`lint`、打包均通过。

## 回滚

纯渲染层与依赖清单改动，不动 SQLite、IPC 协议与主进程。`git checkout -- <paths>` 加 `npm ci` 即可回到迁移前状态。

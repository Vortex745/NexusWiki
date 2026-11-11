# ADR 0002: 采用 TDesign AI 聊天套件与 streamdown 渲染器

日期：2026-11-07　状态：已采纳　取代：ADR 0001 中「不引入 `@tdesign-react/chat`」的排除裁决

## 背景

ADR 0001（2026-11-06）以两条理由排除了 `@tdesign-react/chat`：61.2 MB 传递依赖，以及它会打开已关闭的 XSS 面。用户在 2026-11-07 的调研后明确推翻该裁决：聊天区改用 TDesign AI 组件套件，markdown 渲染器换成 Vercel streamdown，并补齐停止与重新生成。

## 证据（npm tarball 解包实测）

- `@tdesign-react/chat` 1.1.0 是 Web Components 薄壳（reactify 桥），实现在 `@tdesign/web-components-chat` 1.3.3（Omi），状态与协议在 `@tdesign/ai-chat-engine` 0.1.0。
- 61.2 MB 的量级来自 cherry-markdown 55.7 MB 与 `@tdesign/web-components` 5.9 MB 两层（合计 61.6 MB，与当年口径同源），两层仍在依赖树里。
- `ChatMessage` 的依赖链强制带入 cherry-markdown 与 engine runtime（`__reExport` 动态枚举击穿树摇）；本集成经 `slot="markdown-0"` 用 streamdown 覆盖内置渲染器，cherry 成为纯死重（约 +3.6 MB minified）。
- 深路径导入可避开 root barrel 的 zod 3 双版本与 1 MB engine 绑定。

## 决定

1. 组件级集成：`ChatMessage`/`ChatThinking`/`ChatSender`/`ChatActionBar` 接管消息、思考、输入、操作栏；保留自家 zustand store 与 IPC 增量协议；`Chatbot` 全家桶与其网络层不采用（它强制接管传输层）。
2. markdown 渲染器 = streamdown 2.7.1（rehype-harden 默认加固），移除 react-markdown/remark-gfm/remark-breaks/@tailwindcss/typography。
3. 新增 `chat:stop` 与 `chat:regenerate`；重新生成用 `SessionManager.branch` 截断到最后一条 user 条目之前（根情形 `resetLeaf`），保留前文上下文，渲染层乐观移除旧轮。

## 后果

- XSS 面重开后已重新验收：7 类载荷（img onerror / script / iframe javascript: / markdown javascript: 链接 / svg onload / a onclick / data URI img）在真机探针全部中和，rehype-harden 对链接统一 `_blank` + `noopener noreferrer`。
- 体积代价被接受并记录：renderer 主 chunk 1,633 KB → 7,161 KB（cherry + engine + shiki + streamdown），CSS 181.9 KB → 199.1 KB。若需回收，杠杆是懒加载 WC 模块或上游提供 cherry-free 入口。
- 视觉契约（ADR 0001 时代的 plain_text_plus_loading）部分让位：气泡、思考卡、输入壳由套件承载，经 `--td-chat-*` 与 `::part` 对齐安静表面；工具/任务/压缩行保持自控组件。
- 传递依赖新增 omi、immer、zod 4、@json-render/core；维护风险为上游早期版本（engine 0.1.0、chat 1.1.0，2026-09 后无新发布），API 变动需锁版本升级。

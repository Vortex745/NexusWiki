# Spec: Super-agent MVP（本地双层 Agent）

## Problem Statement

用户想要一个常驻本地的 Super-agent：一个入口对话、多个 Worker 并行执行任务、状态可恢复。现有项目只有 Electron 脚手架（主进程 + 渲染层，无 IPC 桥），没有任何 Agent 能力。

## Solution

在 Electron 主进程内用 pi SDK（`@earendil-works/pi-coding-agent`）构建双层 Agent：常驻 Router session（轻量模型，只协调不执行）+ 按任务 spawn 的 Worker session（全量工具，目录隔离）。渲染层为聊天工作台，经 preload IPC 与主进程通信。SQLite 记录任务。唯一出网流量 = LLM API。

## 技术栈定稿

- Electron 40（主进程 = Node 24）+ React 19 + TS + Tailwind v4 + shadcn(Nova)
- Agent 内核：pi SDK，models.json 接 OpenAI 兼容 API；测试用可注入假模型
- 数据：node:sqlite（WAL，userData/app.db）+ pi JSONL 会话持久化
- 约束：全部本地执行；渲染层 sandbox: true；Worker cwd = userData/workspace/<task_id>/（隔离且随应用数据卸载）

## 分层（对齐 Yuxi 七层映射）

1 体验=聊天工作台；2 API=类型化 IPC + 进程内任务队列；3 Runtime=Router/Worker pi sessions；4 沙箱=workspace 目录隔离；5 工具=pi 内置 + 自有工具；6 知识检索（后置）；7 基建=SQLite+文件系统（后置）。

## Testing Decisions

- 双层测试接缝（实际落地，修订自最初"唯一接缝=IPC API 面"）：自动化 = `createRouter`/`createTaskDispatcher` 模块边界——即 IPC handler 的薄壳内芯（`node --test` 直接跑，零 electron mock）；端到端 = dev 窗口手动冒烟（聊天 + 任务事件行内联渲染）。理由：ipc.ts 是 electron 薄壳（app/webContents/ipcMain 绑定），为它 mock electron 得不偿失，而 handler 的全部业务逻辑都在被测的 Router/dispatcher 里。
- pi model 为可注入边界：自动化测试注入脚本化假模型（确定性、零 API 成本）；真模型仅留手动冒烟验收。
- 好测试只断言外部行为（回复内容、事件序列、落库状态），不断言内部实现。

## Out of Scope

外部事件源（文件/git/cron）、两级过滤、Thread/订阅直通、链式召回、批处理缓冲、Watchdog、异步 start/stop 工具、投机执行、任务面板页、知识检索、Nest.js 后端（已否决）。

## Tickets

见 issues/01..06（依赖序：01→02→03→{04,05,06}）。

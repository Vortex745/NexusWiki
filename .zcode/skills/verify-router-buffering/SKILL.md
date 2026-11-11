---
name: verify-router-buffering
description: "形式化验证 RouterLoop 攒批状态机（src/main/chat/router.ts）：TLC 穷举所有消息交错顺序，检查消息不丢、不重复收尾、不死等。改动 router.ts 的 send/settle/pump/failRun/dispose/message_end 逻辑后、或怀疑「发消息没反应/重复气泡/排队卡死」类 bug 时使用。跑 npm run tlc。"
---

# 验证 RouterLoop 攒批状态机

本仓库用 TLA+ TLC 模型检查器穷举 `src/main/chat/router.ts` 中 RouterLoop 攒批状态机的所有消息交错顺序。规格在 `formal/RouterLoopBuffering.tla`（同名 `.cfg` 是主门禁配置），背景、性质白话表、代码映射、边界假设都在 `formal/README.md`——先读它再动规格。

## 什么时候本验证被触及

改动 `src/main/chat/router.ts` 中以下任何一处，就触及了被验证的代码：

- `RouterLoop` 类的字段（`currentIds`/`pendingBuffer`/`doneIds`/`runActive`/`compacting`/`disposed`/`errorSeen`）或其读写
- `send` / `settle` / `pump` / `failRun` / `dispose` / `complete` / `emitErrorFor`
- `onEvent` 里 `message_end`、`compaction_start/end`、`agent_settled`、`message_update` error 分支
- `startRun`（包括它的 promise 链与同步 throw 路径）

渲染层 store、DeltaBatcher、dispatcher 不在本验证范围（DeltaBatcher 与任务生命周期是登记在 README 的扩展点，各有待写规格）。

## 怎么跑

```bash
npm run tlc
```

约 1 秒。**全绿 = 124 个可达状态（MaxSends=3）全部遍历，5 条不变量 + 1 条活性通过。** 输出里有 `Model checking completed. No error has been found.` 才算绿；TLC 对违例以非零退出码结束（不变量 12 / 活性 13），接 CI 可靠。

## 怎么读结果：真 bug 还是建模错误

 TLC 报违例时，会打印一条最短反例轨迹，每个状态一行变量值。**用 `pstack statechart` skill 读这条轨迹**——它把违例画成状态机路径，用代码的语言讲清楚是哪几步出的问题；通过时它也能画出系统的状态迁移图。那个 skill 的命令与安装方式随版本变化，不要抄历史命令，直接调它。

三类结果，三种处理：

1. **违例轨迹能在 router.ts 里对号入座**（比如：dispose 之后 FailRun 还在终结消息）→ 真 bug 或真防御缺口。按 `formal/README.md`「发现 #1」的格式记录：轨迹、代码机理、修法建议。**不要为了让它变绿而放宽性质或改模型**，也不要顺手改产品代码——报告给用户裁决。
2. **轨迹暴露的是模型与代码不一致**（比如：模型里某个守卫代码里已经改了）→ 模型过期。跳到下面「改了代码怎么办」。
3. **语法/求值错误**（`Unknown operator`、`Successor state is not completely specified`）→ 建模错误，不是 bug。求值错误常是 UNCHANGED 清单漏变量；动作从未触发（`-coverage 1` 下某动作 0 次命中）常是同一动作里两个子合取各自规定同一个 primed 变量导致冲突。修模型，不动性质。

## 改了代码怎么办

- **无意破坏**（重构碰到了被验证逻辑，验证红了）：先修代码让验证回绿；确实要保留新行为就走下一行。
- **有意改变语义**：先改 `formal/RouterLoopBuffering.tla` 让它描述新语义，跑 TLC 裁决，再把 `formal/README.md` 的性质表、映射行号和下面的 sync commit 一并更新。
- **sync commit 纪律**：只有当你亲自确认规格如实描述了新 commit 的代码后，才把覆盖记录的 sync commit 前移（当前：`c587af7`）。代码动了、没验证，commit 不动——下一个 agent 会看到验证过期。

## 已知违例（改主 cfg 前必读）

`NoFinalAfterDispose` 当前**预期红**，单独放在 `formal/RouterLoopBuffering-findings.cfg`（发现 #1：failRun 无 disposed 守卫，dispose 与流错误竞态时旧 Router 向新时间线发终结 chunk，修法与轨迹见 `formal/README.md`）。主 cfg 保持绿门禁。用户裁决修复后：failRun 加守卫 → findings 复跑变绿 → 把 `NoFinalAfterDispose` 移回主 cfg → 删掉本节。

## 变异自检

对规格或检查流程有任何怀疑时，按 `formal/README.md`「变异记录」做一次：故意改坏一个动作 → TLC 必须变红 → 还原 → 必须回绿。检查器自己先可信，验证结果才可信。

## 工具链

jar 在 `formal/vendor/tla2tools.jar`（gitignore，不入库）；版本、下载命令、SHA-256 见 `formal/README.md`。新机器 clone 后先按 README 下载 jar，`npm run tlc` 报 `Missing input TLA+ module` 之外的错先怀疑 jar 缺失。TLC 必须在 `formal/` 目录内运行（npm script 已处理：模块名必须与文件名一致）。

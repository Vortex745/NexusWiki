---
name: verify-router-lifecycle
description: "形式化验证 Router 生命周期（src/main/chat/ipc.ts + src/main/chat/router-slot.ts）：TLC 穷举新会话/切会话/记忆重建与 Router 创建完成的交错顺序，检查「同一时刻至多一个 Router 存活」。改动 routerSlot/getRouter/CHAT_NEW_SESSION/CHAT_SWITCH_SESSION/rebuildRouterIfIdle/router-slot.ts，或怀疑「多出会话文件/重复 MCP 子进程/重启进错会话/切会话进错会话」时使用。跑 npm run tlc:lifecycle。"
---

# 验证 Router 生命周期

本仓库用 TLA+ TLC 穷举 `src/main/chat/ipc.ts` 中 `routerSlot` 单指针的生命周期：Router 创建、新会话、切会话、记忆整理后的热重建。规格在 `formal/RouterLifecycle.tla`，主配置 `RouterLifecycle.cfg` 全绿。详细代码映射、回归记录、变异记录与边界在 `formal/RouterLifecycle.md`，先读它再动规格。

## 什么时候本验证被触及

改动以下任何一处，就触及了被验证的代码：

- `src/main/chat/ipc.ts` 的 `routerSlot` / `nextRouterTarget` 读写
- `createRouterPromise` 与 `getRouter`
- `CHAT_NEW_SESSION` handler（设 target → await 当前 promise → release → await getRouter）
- `CHAT_SWITCH_SESSION` handler（同结构）
- `rebuildRouterIfIdle`（await 当前 promise → isIdle → release → await getRouter）
- `src/main/chat/router-slot.ts` 的 `ensure` / `release`
- `src/main/memory/ipc.ts` 里调用 `rebuildRouterIfIdle` 的位置（它决定重建入口是 microtask 还是宏任务）

不在本验证范围：`createRouter` 内部、`RouterLoop` 攒批（那是 `.zcode/skills/verify-router-buffering`）、渲染层、db、MCP/子代理扩展本体。

## 怎么跑

```bash
npm run tlc:lifecycle
```

约 1 秒。**全绿 = 314 states generated / 208 distinct / 深度 12（Routers={r1,r2,r3}）**，输出有 `Model checking completed. No error has been found.`。TLC 对违例非零退出（不变量 12 / 活性 13），接 CI 可靠。

## 怎么读结果：真 bug 还是建模错误

TLC 报违例时会打印一条最短反例轨迹（每个状态一行变量值）。**用 pstack 的 `statechart` skill 读它**，它把轨迹画成状态机路径并用代码的语言解释。那个 skill 的命令与安装随版本变化，不要抄历史命令，直接调它。

三类结果，三种处理：

1. **轨迹能在 `ipc.ts` / `router-slot.ts` 里对号入座**（例如：两个入口都等同一个 pending promise，后恢复者无条件清空）→ 真回归。按 `formal/RouterLifecycle.md`「回归记录」的格式记录轨迹、代码机理、修法。**不要为了让它变绿而放宽性质或改模型**，也不要顺手改无关代码。
2. **轨迹暴露的是模型与代码不一致**（例如：代码已经改成身份校验而模型没改）→ 模型过期。跳到下面「改了代码怎么办」。
3. **语法/求值错误**（`Unknown operator`、`Successor state is not completely specified`、函数作用域越界）→ 建模错误，不是 bug。常见原因：动作里某个变量既被显式赋值又漏在 `UNCHANGED` 清单；`\/` 两侧都会被求值（索引 `status["none"]` 会炸，用 `IF ... THEN TRUE ELSE ...`）；`FinishCreate` 的 `queue = <<>>` 是任务边界假设。

## 回归历史（改身份校验前必读）

修复前：`await` 完捕获的 promise 之后无条件 `routerPromise = null`，把另一个入口刚创建的 Router 丢出引用。实机复现：启动创建窗口 10 秒，第 5 秒切到会话 B，时间线显示旧会话 A。修复把身份校验收进 `router-slot.ts` 的 `release`，三处共用；修复后同一探针显示 B。

现在 `AtMostOneLive` 是绿门禁。它变红意味着身份校验被删掉或绕过了：

- `release` 里的 `promise !== captured` 判断被删
- 调用方绕过 `release` 直接 `dispose()` + 清空
- 新增了第四个生命周期入口但没有走 `release`

不要把它移回一个长期红的 findings 配置。回归是回归，修代码。

## 改了代码怎么办

- **无意破坏**（重构碰到了被验证逻辑，验证红了）：先修代码让验证回绿；确实要保留新行为就走下一行。
- **有意改变语义**：先改 `formal/RouterLifecycle.tla` 描述新语义，跑 TLC 裁决，再把 `formal/RouterLifecycle.md` 的性质表、代码映射行号和下面的 sync commit 一并更新。
- **sync commit 纪律**：只有当你亲自确认规格如实描述了新 commit 的代码后，才把覆盖记录的 sync commit 前移（当前：`7bd7e86`）。代码动了、没验证，commit 不动。长期未同步时用 `/maintain-formal-verification-skill` 带回同步。

## 变异自检

对规格或检查流程有任何怀疑时，按 `formal/RouterLifecycle.md`「变异记录」做一次：在 `.tmp/` 副本里删掉身份校验 → `AtMostOneLive` 必须变红；把「dispose 后清空」删掉 → `PromiseRefNotDisposed` 必须变红。检查器自己先可信，验证结果才可信。

## 工具链

jar 在 `formal/vendor/tla2tools.jar`（gitignore，不入库）；版本、下载命令、SHA-256 见 `formal/README.md`。TLC 必须在 `formal/` 目录内运行（npm script 已用 `cd formal` 处理：模块名必须与文件名一致）。`-deadlock` 是 TLC 的「不检查死锁」开关，有界模型里 Router 用完会人为堵死，死锁不是本验证的性质。跑完若残留 `formal/*_TTrace_*` 或 `formal/states/`，删掉（均已 gitignore）。

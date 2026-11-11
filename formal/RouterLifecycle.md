# Router 生命周期（routerPromise 单指针）的 TLA+ 模型检查

用 TLC 穷举 `src/main/chat/ipc.ts` 里 Router 创建/销毁入口的所有交错顺序，机器验证「同一时刻至多一个 Router 存活」。模型直接建模 JS 的 microtask 队列：**一个原子步 = 一次同步函数调用或一个 microtask 回调**；宏任务（IPC 入口）只在队列清空后开始；`await` 一个 pending promise 的续体在该 promise resolve 时按挂接顺序入队。

规格：`formal/RouterLifecycle.tla`。主门禁：`RouterLifecycle.cfg`，全部性质通过。

## 运行

```bash
npm run tlc:lifecycle
```

约 1 秒。输出 `Model checking completed. No error has been found.` 才算绿。TLC 违例非零退出（不变量 12 / 活性 13），可接 CI。jar、版本、SHA-256 与 Java 依赖见 `formal/README.md`（同一个 `formal/vendor/tla2tools.jar`）。`-deadlock` 是 TLC 的「**不**检查死锁」开关，有界模型里 Router 用完会人为堵死，死锁不是本验证的性质。

## 为什么选这个目标

- **失败代价高**：同时存活两个 Router = 两份 AgentSession、两条会话事件订阅、两套 MCP stdio 子进程与两个子代理桥。被丢出引用的那个永不 dispose，子进程跟着泄漏；它的 `createRouter` 完成时还会写 db 的 current session，重启可能进入非预期会话。
- **测试盲区**：`ipc.ts` 是薄 Electron 壳，测试接缝只在 `createRouter`；这些入口的交错顺序没有单元测试覆盖。
- **触发形态明确**：Router 创建未完成时，两个生命周期入口同时挂在同一个 pending promise 上；创建 resolve 后两个续体在同一个 microtask checkpoint 里 FIFO 恢复。后恢复者若无条件清空指针，就会把前一个入口刚创建的 Router 丢出引用。

## 代码映射（动作 = 一个同步块或一个 microtask 回调）

| 模型动作 | 代码 |
|---|---|
| `EnsureRouter` | ipc.ts:138-174 `createRouterPromise` 与 `getRouter` 的 `routerSlot.ensure`（启动、聊天入口等任意调用者） |
| `SessionEnterQueue` / `SessionEnterWait` | ipc.ts:221-223 / 260-262：设 `nextRouterTarget`、`await routerSlot.current()`；已 resolve → 续体立即入队，pending → 挂成 waiter |
| `QueueRebuildEntry` | memory/ipc.ts:106（整理完成的续体调用 `rebuildRouterIfIdle`；这是 microtask 入口，可插在已入队的会话续体前面） |
| `DrainRebuildEntry` | ipc.ts:288-294：`await` 旧 promise 的入口与续体 |
| `FinishCreate` | ipc.ts:150-172：`createRouter` resolve + `setSetting`；等同一个 promise 的续体按挂接顺序入队 |
| `DrainSession` | ipc.ts:222-225 / 261-264：`routerSlot.release` 身份校验 → dispose + 清空 + `await getRouter()` |
| `DrainRebuild` | ipc.ts:290-294：`isIdle` + `routerSlot.release` 身份校验 → dispose + 清空 + `await getRouter()` |

`routerSlot.release(captured, resolved, dispose)` 在 `router-slot.ts`：只有 `routerSlot.current() === captured` 时才 dispose 并清空，否则返回 false，调用方复用当前 Router。

## 验证的性质（白话）

| 性质 | 白话 | 结果 |
|---|---|---|
| `TypeOK` | 状态变量都在定义域内 | 绿 |
| `PromiseRefNotDisposed` | `routerPromise` 永不指向已 dispose 的 Router | 绿 |
| `WaitingOnCreating` | waiter 只挂在创建中的 Router 上 | 绿 |
| `BothWaitingOrdered` | 两个入口同时等待时，恢复顺序已知（模型自检） | 绿 |
| `AtMostOneLive` | 同一时刻至多一个 Router 存活 | 绿 |

## 基线结果（Routers={r1,r2,r3}）

314 states generated / 208 distinct / 深度 12 / 亚秒完成，无错误。

## 回归记录（已修复）

**现象**：Router 创建未完成时，两个生命周期入口同时挂到同一个 pending promise 上。创建 resolve 后，后恢复的入口无条件执行 `routerPromise = null`，把前一个入口刚创建的 Router 丢出引用且永不 dispose。两个 Router 同时存活。

**实机复现**（`.tmp/router-lifecycle-repro/probe.mjs`，本地验收脚本，不入库）：fake 模式，启动时把第一次 Router 创建拉长到 10 秒；记忆整理在约 3 秒完成并加入同一个 pending promise；第 5 秒通过 `window.api.switchChatSession(B)` 切到会话 B。修复前时间线显示旧会话 A 的历史，会话列表把 A 标成 current；修复后显示 B，B 成为 current。两次运行日志：

```text
# 修复前
PASS race history arrived -- ALPHA=true BETA=false
PASS buggy switch lands on the old session A -- ALPHA=true BETA=false

# 修复后
PASS race history arrived -- ALPHA=false BETA=true
PASS fixed switch lands on the requested session B -- ALPHA=false BETA=true
```

**根因**：`const current = await routerPromise?.catch(...)` 记住的是 Router 值，不是「它是否仍是当前 promise」。`if (current) { current.dispose(); routerPromise = null }` 不校验身份。回归历史显示这段代码从 e1bdeb9 的模式复制到新会话（8703993）、切会话（95c6ef3）、记忆重建（b2fef2a），从未有过身份校验。

**修复**：把单指针收进 `router-slot.ts`，三处共用 `release` 的身份校验。会话入口在指针已被替换时跳过 dispose，直接复用新 Router；记忆重建在指针已被替换时放弃本次重建。修复前的反例在 git 8db8e54 的 `RouterLifecycle-findings.cfg` 里；该配置已随修复删除。

## 变异记录（证明检查器能抓到真回归）

在 `.tmp/` 的副本上做，不动仓库规格：

| 变异 | 镜像的回归 | TLC 结果 |
|---|---|---|
| M1 删掉身份校验 | `DrainSession` / `DrainRebuild` 回到无条件清空 | `AtMostOneLive` 违例 |
| M2 dispose 后忘记清空 | `DrainSession` 只 dispose、不清 `promiseRef` | `PromiseRefNotDisposed` 违例 |

## 边界与假设（诚实声明）

- **有界模型**：3 个 Router 实例。真实应用不设上限。
- **一个会话槽位**：新会话与切会话生命周期同构，模型只建一个；两个会话入口同时入场与「会话 + 重建」共享同一窗口。
- **`isIdle` 作为环境非确定性**：模型不建 run 状态，`DrainRebuild` 的 skip/do 两支都允许。
- **不建模 createRouter 失败**：失败后 `routerPromise` 永久 rejected、没有复位路径，是另一个独立发现，未进本规格。
- **不建模**：会话 id 与 db current 的读写、`nextRouterTarget` 的 new/resumeId 差异、渲染层 reset/history 推送、MCP 子进程与子代理桥本体。
- **pass 覆盖模型**：模型与 `ipc.ts` 的同步性靠人工比对维护；改代码后按 `.zcode/skills/verify-router-lifecycle/SKILL.md` 判断是否触及。

## 覆盖记录

- sync commit：**7bd7e86**（fix(chat): 用身份校验修掉 Router 生命周期双活竞态）。
- 覆盖文件/函数：`src/main/chat/ipc.ts` 的 `registerChatIpc` 生命周期，`src/main/chat/router-slot.ts` 的 `release`，`src/main/memory/ipc.ts` 中调用 `rebuildRouterIfIdle` 的位置。
- 改动上述代码后：重跑 `npm run tlc:lifecycle`；语义有意变化时先改规格再裁决，确认规格如实描述新代码后才前移 sync commit。

## 读结果

TLC 报违例时用 **pstack `statechart` skill** 读反例轨迹。它的命令与安装随版本变化，不要抄历史命令。

## 相关

- 另一个验证：`formal/README.md`（RouterLoop 攒批状态机，`npm run tlc`）。
- 代码改动后把验证带回同步：`/maintain-formal-verification-skill`。

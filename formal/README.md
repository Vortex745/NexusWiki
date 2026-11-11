# formal — RouterLoop 攒批状态机的 TLA+ 模型检查

用 TLC（TLA+ 模型检查器）穷举 `src/main/chat/router.ts` 中 RouterLoop 攒批状态机的所有消息交错顺序，机器验证手工论证过的并发不变量。规格建模原则：**一个原子步 = 一次同步函数调用**（JS 单线程语义），状态变量与 RouterLoop 私有字段一一对应。

## 运行

```bash
npm run tlc          # 主门禁：5 条不变量 + 活性，预期全绿
java -cp formal/vendor/tla2tools.jar tlc2.TLC -deadlock -cleanup \
  -config formal/RouterLoopBuffering-findings.cfg formal/RouterLoopBuffering.tla
                     # 发现 #1 复现（在 formal/ 目录内执行），预期红
```

TLC 违例时非零退出（不变量 12 / 活性 13），可接 CI。`formal/vendor/` 不入库。

## 工具

- tla2tools.jar **v1.8.0**（tlaplus/tlaplus release；仓库已从 `tla2tools` 改名 `tlaplus`）
- 下载：`curl -L -o formal/vendor/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar`
- SHA-256：`7a0a1e90628ebff2e3e8733375f8b684fa59504d2e02bddc4cb51a7679bb7e04`
- 运行时依赖系统 Java（本机 Amazon Corretto 25）

## 验证的性质（白话）

| 性质 | 白话 | 对应代码 |
|---|---|---|
| `NoDoubleFinal` | 每条消息至多收尾一次（done 唯一且是该 id 最后一个事件） | router.ts:787-806 `emitErrorFor`/`complete` 的 doneIds 守卫 |
| `IdleNoPumpGap` | 不存在「缓冲非空但没人管」的死等——排着队时系统必然忙碌或已放弃 | router.ts:743-759 `settle`/`pump` 同步原子性（T5 手证的机器版本） |
| `CurrentIdsUnfinalized` | 本次 run 认领的消息都是没终结过的 | 同上守卫族 |
| `BufferIdsUnfinalized` | 缓冲里都是未终结的消息 | 攒批缓冲语义 |
| `LivenessAllSettled` | 每条已发消息最终要么收到终结、要么因 dispose 被放弃 | send→缓冲→pump→run→message_end/settle 全链 |
| `NoFinalAfterDispose` | dispose 后不再发生任何终结 | **当前违例，见发现 #1** |

## 基线结果（2026-11-06，MaxSends=3）

360 状态生成 / 124 可达状态全遍历 / 深度 8 / 亚秒完成；除发现 #1 外全部通过。动作覆盖核验（`-coverage 1`）：Send / MessageEndStop / MessageEndError / StreamError / FailRun / AgentSettled / CompactionStart / CompactionEnd / Dispose 全部触发。

## 发现 #1（待用户裁决，未修）

**failRun 没有 disposed 守卫，dispose 与流错误竞态时旧 Router 会向新时间线发终结 chunk。**

TLC 违例轨迹（3 条消息）：`Send×3` → `CompactionStart` → **`Dispose`**（缓冲还压着 2 条）→ **`FailRun`** → 三条消息在 dispose 之后全部终结。

代码机理：`createRouter` 的 promise 链 `void run.then(_, failRun)`（router.ts:622-624）在 `dispose()` 后仍存活；`session.dispose()` 走 `agent.abort()`，abort 让 prompt **resolve 不 reject**（HANDOFF T4 已验证），所以常规路径无害；但当流错误已经发生、拒绝排在微任务队列里时，用户此刻点「新会话」→ `dispose()` → 微任务里 `failRun` 照常执行 → `complete`/`emitErrorFor` → `batcher.terminate` **绕过已 dispose 的 batcher 直接 emit** → 渲染层对新时间线懒 upsert 出幽灵气泡。与 HANDOFF 已记录的「压缩中切模式留永久行」同族。

修法（一行，等裁决）：`failRun` 开头加 `if (this.disposed) return`。修复后把 `NoFinalAfterDispose` 从 findings cfg 移回主 cfg。

## 变异记录（证明检查器能抓到真回归）

每个变异镜像一种真实会犯的代码回归，TLC 必须变红：

| 变异 | 镜像的回归 | TLC 结果 |
|---|---|---|
| M1 failRun 不清缓冲 | 删掉 router.ts:774-775 | `IdleNoPumpGap` 违例（exit 12） |
| M2 settle 丢 pump | settle 不再泵出缓冲 | `IdleNoPumpGap` 违例（exit 12） |
| M3 error 分支不终结只清 currentIds | **线上「发消息石沉大海」bug 的复刻** | `LivenessAllSettled` 违例（exit 13） |
| M4 doneIds 守卫 + currentIds 清空同删 | 双防御同时被重写掉 | `CurrentIdsUnfinalized` + `NoDoubleFinal` 违例（exit 12） |

变异方法：改 `formal/RouterLoopBuffering.tla` 对应动作（见规格内注释标注的动作），跑 `npm run tlc`，记录违例，还原。还原后必须恢复全绿。

## 边界与假设（诚实声明）

- **有界模型**：`MaxSends=3`。消息 id 确定性取最小未用——消息除到达时机外可互换，不损失交错覆盖。
- **不建模**：stopReason=toolUse 的 message_end（currentIds 保持，状态无变化的 stutter）；DeltaBatcher 的 16ms 定时与 512 字符冲刷（I1/I2 是另一条规格的活，扩展点）；错误文本内容（`errorSeen` 布尔化）；消息正文与扇出顺序。
- **failRun 的 phase="running" 守卫**：终态事件已到后的 promise 拒绝对可达终态集合无影响（currentIds 已空，缓冲最终同样被 complete），模型收敛在 running 档。
- **终态事件重复投递**：currentIds 已空 → 处理器 break（动作禁用），与代码一致；doneIds 守卫作为第二层防御被 `NoDoubleFinal` 覆盖。
- **pass 覆盖模型而非全部实现**：规格与 router.ts 的同步性靠人工比对维护，见下方覆盖记录。

## 覆盖记录

- sync commit：**c587af7**（docs(handoff): markdown 渲染决策、验收与踩坑）
- 覆盖文件：`src/main/chat/router.ts` 的 `RouterLoop` 类（523-807 行）与 `mergeBufferItems` 的「多条合并」语义（缓冲全量取出，与顺序无关）
- 改动 RouterLoop 的缓冲/收尾/settle/dispose 逻辑后：重跑 `npm run tlc`；若语义有意变化，先改规格再让 TLC 重新裁决。更详细的操作指引见 `.zcode/skills/verify-router-buffering/SKILL.md`

## 扩展点（未做）

- DeltaBatcher 合批器（I1 每 id delta 拼接恒等、I2 done 唯一且最后）——独立规格
- 任务生命周期（dispatcher 的 queued/running/done/failed/aborted/interrupted + 叫停竞态 + recoverInterruptedTasks）
- 渲染层 chat-store 的懒 upsert 与 `chat:history` 去重合并

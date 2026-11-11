------------------------------- MODULE RouterLoopBuffering -------------------------------
(***************************************************************************)
(* 模型对象：src/main/chat/router.ts 的 RouterLoop 攒批状态机。             *)
(*                                                                          *)
(* 建模忠实度原则：一个原子步 = 一次同步函数调用（JS 单线程语义）。         *)
(* send / settle(含 pump) / compaction_end(含 pump) / failRun / message_end *)
(* 分支 / dispose 各为一个动作；pi 事件流的到达时机是环境的非确定性。       *)
(*                                                                          *)
(* 刻意不建模（见 formal/README.md「边界」）：                              *)
(*   - stopReason=toolUse 的 message_end（currentIds 保持，状态无变化）     *)
(*   - DeltaBatcher 的 16ms 定时与 512 字符冲刷（独立规格，扩展点）         *)
(*   - 错误文本内容（errorSeen 简化为布尔）                                 *)
(*   - 消息正文与扇出顺序（finalCount 只按 id 计数）                        *)
(*                                                                          *)
(* 消息 id 取 1..MaxSends，Send 恒取最小未用 id：消息除到达时机外可互换，  *)
(* 确定性编号不损失交错覆盖，却把状态空间压缩约 3! 倍。                     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxSends    \* 发送消息总数上界（cfg 中 = 3）

Messages == 1 .. MaxSends

\* 序列转集合（pendingBuffer 是 FIFO 序列，pump/failRun 全量取出，与顺序无关）
BufSet(p) == {p[i] : i \in 1 .. Len(p)}

(*** 状态变量 —— 与 RouterLoop 私有字段一一对应 ***)
VARIABLES
  \* router.ts:527 runActive —— 一次 prompt() 进行中
  runActive,
  \* router.ts:528 compacting —— pi 自动压缩进行中（压缩中 prompt() 会 throw）
  compacting,
  \* router.ts:530 disposed —— dispose() 已调用
  disposed,
  \* router.ts:524 currentIds —— 本次 run 服务着的消息 id（代码为数组；
  \*   扇出对每个 id 做同一件事，与顺序无关，建模为集合）
  currentIds,
  \* router.ts:525 pendingBuffer —— 攒批缓冲（FIFO）
  pendingBuffer,
  \* router.ts:526 doneIds —— 已终结的消息 id
  doneIds,
  \* router.ts:529 errorSeen —— 本 run 是否见过模型错误（代码存错误文本）
  errorSeen,
  \* run 阶段：idle=无 run；running=终态事件未到；ended=终态事件已到、等 settle。
  \* 代码里由 currentIds 是否为空 + 事件到达顺序隐式表达，这里显式化以约束
  \* 「终态事件每 run 至多一次」（重复投递时 currentIds 已空 → 处理器 break）
  phase,
  \* 每 id 的终结次数（complete/emitErrorFor 的调用计数）。
  \* doneIds 是集合，重复 add 查不出来；NoDoubleFinal 靠它查重
  finalCount,
  \* 已发送的消息 id（活性属性量化用）
  sentIds

-----------------------------------------------------------------------------
(*** 全变量元组：[]_vars 与 WF_vars 的下标 ***)
vars == << runActive, compacting, disposed, currentIds, pendingBuffer, doneIds, errorSeen, phase, finalCount, sentIds >>

(*** 初始化：router.ts 构造函数 ***)
Init ==
    /\ runActive = FALSE
    /\ compacting = FALSE
    /\ disposed = FALSE
    /\ currentIds = {}
    /\ pendingBuffer = <<>>
    /\ doneIds = {}
    /\ errorSeen = FALSE
    /\ phase = "idle"
    /\ finalCount = [id \in Messages |-> 0]
    /\ sentIds = {}

Busy == runActive \/ compacting \/ (pendingBuffer # <<>>)

(*** router.ts:802 complete / 787 emitErrorFor 的公共内核：
 *** doneIds 守卫（id 已终结则不再追加）+ 计数 + 记账。
 *** kind（stop/error）不入状态：两者对后续行为无影响 ***)
CompleteAll(S) ==
    LET newly == S \ doneIds
    IN  /\ doneIds' = doneIds \cup newly
        /\ finalCount' = [id \in Messages |-> IF id \in newly THEN finalCount[id] + 1 ELSE finalCount[id]]

-----------------------------------------------------------------------------
(*** router.ts:567 send：disposed 时 throw（对本状态机 = 无操作）；
 *** 忙碌（run 进行中 / 压缩中 / 已有排队）入缓冲，空闲直接开 run ***)
Send ==
    /\ ~disposed
    /\ sentIds # Messages
    /\ LET id == CHOOSE id \in Messages : id \notin sentIds
       IN
         \/ /\ Busy
            /\ pendingBuffer' = Append(pendingBuffer, id)
            /\ sentIds' = sentIds \cup {id}
            /\ UNCHANGED <<runActive, compacting, disposed, currentIds, doneIds, errorSeen, phase, finalCount>>
         \/ /\ ~Busy
            /\ sentIds' = sentIds \cup {id}
            /\ currentIds' = {id}
            /\ runActive' = TRUE
            /\ errorSeen' = FALSE
            /\ phase' = "running"
            /\ UNCHANGED <<compacting, disposed, pendingBuffer, doneIds, finalCount>>

(*** router.ts:649-663 message_end 的两个终态分支。
 *** 守卫 phase="running" ∧ currentIds 非空：pi 重复投递终态事件时
 *** currentIds 已空 → 处理器直接 break（动作禁用，与代码一致） ***)

\* stopReason=stop：completeAll 后清 currentIds（router.ts:660-662）
MessageEndStop ==
    /\ ~disposed
    /\ phase = "running"
    /\ currentIds # {}
    /\ CompleteAll(currentIds)
    /\ currentIds' = {}
    /\ phase' = "ended"
    /\ UNCHANGED <<runActive, compacting, disposed, pendingBuffer, errorSeen, sentIds>>

\* stopReason=error：errorSeen 置位 + emitErrorForAll 后清 currentIds（router.ts:653-662）
MessageEndError ==
    /\ ~disposed
    /\ phase = "running"
    /\ currentIds # {}
    /\ errorSeen' = TRUE
    /\ CompleteAll(currentIds)
    /\ currentIds' = {}
    /\ phase' = "ended"
    /\ UNCHANGED <<runActive, compacting, disposed, pendingBuffer, sentIds>>

(*** router.ts:644-646 message_update 的 error 事件：只记 errorSeen，
 *** 不终结 —— 终结发生在后续 message_end 或 settle 兜底 ***)
StreamError ==
    /\ ~disposed
    /\ phase = "running"
    /\ currentIds # {}
    /\ ~errorSeen
    /\ errorSeen' = TRUE
    /\ UNCHANGED <<runActive, compacting, disposed, currentIds, pendingBuffer, doneIds, finalCount, phase, sentIds>>

(*** router.ts:761-777 failRun：prompt() promise 拒绝（或同步 throw）。
 *** 注意：代码里没有 disposed 守卫 —— startRun 的 promise 链在 dispose 后
 *** 仍存活，这是「发现 #1」的根源（见 README）。
 *** phase="running" 守卫：终态事件已到后的拒绝不改变可达终态集合
 *** （currentIds 已空、缓冲最终同样被 complete），模型收敛在 running 档。
 *** 缓冲走的是正常 complete（router.ts:774），与 currentIds 的错误终结不同 ***)
FailRun ==
    /\ runActive
    /\ phase = "running"
    /\ CompleteAll(currentIds \cup BufSet(pendingBuffer))
    /\ pendingBuffer' = <<>>
    /\ currentIds' = {}
    /\ runActive' = FALSE
    /\ errorSeen' = FALSE
    /\ phase' = "idle"
    /\ UNCHANGED <<compacting, disposed, sentIds>>

(*** router.ts:743-752 settle + 755-759 pump：agent_settled 事件触发，
 *** 与 pump 同一个原子步（pump 在 settle 内同步调用 —— 这正是
 *** IdleNoPumpGap 成立的机理）。settle 兜底终结 errorSeen 只决定
 *** kind，对状态无影响；pump 守卫与代码一致 ***)
AgentSettled ==
    /\ ~disposed
    /\ CompleteAll(currentIds)
    /\ IF ~compacting /\ (pendingBuffer # <<>>)
         THEN /\ currentIds' = BufSet(pendingBuffer)
              /\ pendingBuffer' = <<>>
              /\ runActive' = TRUE
              /\ errorSeen' = FALSE
              /\ phase' = "running"
              /\ UNCHANGED <<compacting, disposed, sentIds>>
         ELSE /\ currentIds' = {}
              /\ runActive' = FALSE
              /\ errorSeen' = FALSE
              /\ phase' = "idle"
              /\ UNCHANGED <<compacting, disposed, sentIds, pendingBuffer>>

(*** router.ts:664-670 compaction_start：压缩发生在 run 进行中 ***)
CompactionStart ==
    /\ ~disposed
    /\ runActive
    /\ ~compacting
    /\ compacting' = TRUE
    /\ UNCHANGED <<runActive, currentIds, pendingBuffer, doneIds, finalCount, errorSeen, phase, sentIds, disposed>>

(*** router.ts:672-685 compaction_end：清除 compacting 并同步 pump。
 *** 压缩中 settle 已跑过时 runActive=FALSE 且缓冲可能非空（settle 的
 *** pump 被 compacting 守卫挡住），由这里泵出 ***)
CompactionEnd ==
    /\ ~disposed
    /\ compacting
    /\ compacting' = FALSE
    /\ IF ~runActive /\ (pendingBuffer # <<>>)
         THEN /\ currentIds' = BufSet(pendingBuffer)
              /\ pendingBuffer' = <<>>
              /\ runActive' = TRUE
              /\ errorSeen' = FALSE
              /\ phase' = "running"
              /\ UNCHANGED <<disposed, sentIds, doneIds, finalCount>>
         ELSE /\ UNCHANGED <<runActive, currentIds, pendingBuffer, errorSeen, phase, disposed, sentIds, doneIds, finalCount>>

(*** router.ts:607-614 dispose：unsubscribe 后事件类动作全部禁用
 *** （各自 ~disposed 守卫）；batcher.dispose 丢弃 delta 缓冲不入模型；
 *** pendingBuffer 原样保留 —— 缓冲消息被放弃，不再有终结 ***)
Dispose ==
    /\ ~disposed
    /\ disposed' = TRUE
    /\ UNCHANGED <<runActive, compacting, currentIds, pendingBuffer, doneIds, finalCount, errorSeen, phase, sentIds>>

-----------------------------------------------------------------------------
Next ==
    \/ Send
    \/ MessageEndStop
    \/ MessageEndError
    \/ StreamError
    \/ FailRun
    \/ AgentSettled
    \/ CompactionStart
    \/ CompactionEnd
    \/ Dispose

(*** 公平性：进行中的 run 必然走向某个终局（正常 / 流错误 / promise 拒绝），
 *** 终态事件到后 settle 必然发生，压缩必然结束。
 *** Send / CompactionStart / Dispose 是环境动作，不加公平性 ***)
RunProgress ==
    \/ MessageEndStop
    \/ MessageEndError
    \/ StreamError
    \/ FailRun

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(RunProgress)
    /\ WF_vars(AgentSettled)
    /\ WF_vars(CompactionEnd)

-----------------------------------------------------------------------------
(*** 不变量与性质 ***)

TypeOK ==
    /\ runActive \in BOOLEAN
    /\ compacting \in BOOLEAN
    /\ disposed \in BOOLEAN
    /\ errorSeen \in BOOLEAN
    /\ currentIds \subseteq Messages
    /\ doneIds \subseteq Messages
    /\ pendingBuffer \in Seq(Messages)
    /\ finalCount \in [Messages -> Nat]
    /\ phase \in {"idle", "running", "ended"}
    /\ sentIds \subseteq Messages

\* 每条消息至多终结一次（done 唯一且是该 id 最后一个事件的消息级版本）
NoDoubleFinal ==
    \A id \in Messages : finalCount[id] <= 1

\* 「缓冲非空但没人泵」的空档不存在（T5 手证的机器版本）：
 \* 排着队的消息时系统必然忙碌或已放弃
IdleNoPumpGap ==
    (pendingBuffer # <<>>) => (runActive \/ compacting \/ disposed)

\* 被本次 run 认领的消息都还没终结过（doneIds 守卫的存在意义）
CurrentIdsUnfinalized == currentIds \cap doneIds = {}

\* 缓冲里都是未终结的消息
BufferIdsUnfinalized == BufSet(pendingBuffer) \cap doneIds = {}

\* 活性：每条已发送的消息，最终要么被终结、要么因 dispose 被放弃
LivenessAllSettled ==
    \A id \in Messages : ((id \in sentIds) ~> ((id \in doneIds) \/ disposed))

\* dispose 后不再发生任何终结（见 README 发现 #1 —— 当前预期违例，
 \* 违例轨迹：Send → Dispose → FailRun（promise 链在 dispose 后仍存活））
NoFinalAfterDispose ==
    \A id \in Messages : ((disposed /\ finalCount[id] = 0) ~> [](finalCount[id] = 0))

=============================================================================

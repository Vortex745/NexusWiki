---------------------------- MODULE RouterLifecycle ----------------------------
(***************************************************************************)
(* 模型对象：src/main/chat/ipc.ts 的 Router 生命周期（routerPromise 单指针）。 *)
(*                                                                          *)
(* 建模忠实度原则：直接建模 JS 的 microtask 队列，而不是用顺序约束近似它。   *)
(*   - 一个原子步 = 一次同步函数调用 / 一个 microtask 回调（JS 单线程）。    *)
(*   - await 一个 promise：续体注册为 reaction；promise 已 resolve 时立即     *)
(*     入队，pending 时等 resolve 那一刻入队。续体按入队顺序 FIFO 执行。     *)
(*   - 宏任务（IPC handler 入口）只在 microtask 队列清空后才可能开始。       *)
(*   - 记忆重建入口本身由「整理完成的续体」触发，所以它是 microtask 入口，   *)
(*     可以插在一个已入队的会话续体前面。                                   *)
(*                                                                          *)
(* 被建模的代码块（行号见 formal/RouterLifecycle.md 覆盖记录）：             *)
(*   ipc.ts:138-174  createRouterPromise + getRouter：取 target、算          *)
(*                   resumeSessionId、await createRouter、写 db；ensure 单飞 *)
(*   ipc.ts:220-227  CHAT_NEW_SESSION：设 target → await 旧 promise →       *)
(*                   release 身份校验 → await getRouter                     *)
(*   ipc.ts:246-269  CHAT_SWITCH_SESSION：结构同上，仅 target 取值不同       *)
(*   ipc.ts:288-296  rebuildRouterIfIdle：await 旧 promise → isIdle →       *)
(*                   release 身份校验 → await getRouter                     *)
(*   ipc.ts:284      启动 void getRouter()                                   *)
(*                                                                          *)
(* 刻意不建模（见 formal/RouterLifecycle.md「边界」）：                      *)
(*   - 会话 id / db current 的读写（被丢弃的创建完成时也会写 db）            *)
(*   - nextRouterTarget 的取值差异（new vs resumeId 只影响选哪个会话文件）   *)
(*   - run 的真实状态：rebuild 的 isIdle 作为环境非确定性（skip/do 两支）    *)
(*   - createRouter 失败（promise 永久 rejected、没有复位路径）              *)
(*   - await getRouter() 之后的 reset/history 推送（不影响 Router 归属）     *)
(*                                                                          *)
(* 两个会话入口（新会话/切会话）在生命周期上结构同构，模型只建一个会话槽位； *)
(* 「同入口连点两次」与「会话入口 + 记忆重建」共享同一个丢失 promise 的窗口。 *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Routers    \* Router 代数编号集合（cfg 中 = {r1, r2, r3}）

VARIABLES
  \* 每个 Router 实例的状态：未创建 / 创建中 / 存活 / 已 dispose
  status,
  \* routerPromise：none 或某个 Router（可能仍在 creating）
  promiseRef,
  \* 会话入口阶段：idle / waiting（挂在一个 pending 创建上） / queued（续体已入队）
  sessionPhase,
  \* 会话入口在 await 时抓住的 routerPromise 值（none 表示入队时 promise 为空）
  sessionCaptured,
  \* 记忆重建入口阶段（同 sessionPhase）
  rebuildPhase,
  \* 记忆重建入口在 await 时抓住的 routerPromise 值
  rebuildCaptured,
  \* microtask 队列（元素：S=会话续体、R=重建续体、E=重建入口）
  queue,
  \* 两个入口同时挂在同一个 pending 创建上时的恢复顺序
  waitOrder

vars == <<status, promiseRef, sessionPhase, sessionCaptured,
          rebuildPhase, rebuildCaptured, queue, waitOrder>>

(*** 初始化：模块加载时 routerPromise=null、队列空、无入口在途 ***)
Init ==
    /\ status = [r \in Routers |-> "unborn"]
    /\ promiseRef = "none"
    /\ sessionPhase = "idle"
    /\ sessionCaptured = "none"
    /\ rebuildPhase = "idle"
    /\ rebuildCaptured = "none"
    /\ queue = <<>>
    /\ waitOrder = "none"

-----------------------------------------------------------------------------
(*** ipc.ts:138-150：宏任务里的 getRouter()（启动 / 聊天入口） ***)
(*** slot 为空时同步段开始 createRouter，然后 await 它。                  ***)
(*** 该调用的续体只做日志/返回，不改 Router 归属，不入队。                 ***)
EnsureRouter ==
    /\ queue = <<>>
    /\ promiseRef = "none"
    /\ sessionPhase = "idle"
    /\ rebuildPhase = "idle"
    /\ \E r \in Routers :
         /\ status[r] = "unborn"
         /\ status' = [status EXCEPT ![r] = "creating"]
         /\ promiseRef' = r
         /\ UNCHANGED <<sessionPhase, sessionCaptured, rebuildPhase, rebuildCaptured,
                        queue, waitOrder>>

-----------------------------------------------------------------------------
(*** ipc.ts:221-223 / 260-262：会话入口（宏任务，队列必须已清空） ***)
(*** 设 target（不建模）→ await routerPromise：                        ***)
(***   已 resolve / 为空 → 续体立即入队                                ***)
(***   仍在 creating   → 挂成该创建的 waiter，resolve 时按序入队       ***)
SessionEnterQueue ==
    /\ queue = <<>>
    /\ sessionPhase = "idle"
    /\ IF promiseRef = "none" THEN TRUE ELSE status[promiseRef] = "live"
    /\ sessionCaptured' = promiseRef
    /\ sessionPhase' = "queued"
    /\ queue' = Append(queue, "S")
    /\ UNCHANGED <<status, promiseRef, rebuildPhase, rebuildCaptured, waitOrder>>

SessionEnterWait ==
    /\ queue = <<>>
    /\ sessionPhase = "idle"
    /\ promiseRef # "none"
    /\ status[promiseRef] = "creating"
    /\ sessionCaptured' = promiseRef
    /\ sessionPhase' = "waiting"
    /\ waitOrder' = IF rebuildPhase = "waiting" /\ rebuildCaptured = promiseRef
                    THEN "rebuildFirst" ELSE "none"
    /\ UNCHANGED <<status, promiseRef, rebuildPhase, rebuildCaptured, queue>>

-----------------------------------------------------------------------------
(*** 记忆重建入口是 microtask：整理完成的续体调用 rebuildRouterIfIdle() ***)
(*** 它的 await routerPromise 续体（R）排进队列尾部，可能落在已入队的  ***)
(*** 会话续体 S 之后。                                                  ***)
QueueRebuildEntry ==
    /\ rebuildPhase = "idle"
    /\ \A i \in 1 .. Len(queue) : queue[i] # "E"
    /\ queue' = Append(queue, "E")
    /\ UNCHANGED <<status, promiseRef, sessionPhase, sessionCaptured,
                   rebuildPhase, rebuildCaptured, waitOrder>>

(*** ipc.ts:290：重建入口执行：current 为空 → return；否则 await 它 ***)
DrainRebuildEntry ==
    /\ Len(queue) > 0
    /\ Head(queue) = "E"
    /\ rebuildPhase = "idle"
    /\ queue' = Tail(queue)
    /\ \/ \* current 为空：直接 return
          /\ promiseRef = "none"
          /\ rebuildPhase' = "idle"
          /\ rebuildCaptured' = "none"
          /\ UNCHANGED <<status, promiseRef, sessionPhase, sessionCaptured, waitOrder>>
       \/ \* await 已 resolve 的 promise：续体立即入队（排在 S 之后）
          /\ promiseRef # "none"
          /\ status[promiseRef] = "live"
          /\ rebuildCaptured' = promiseRef
          /\ rebuildPhase' = "queued"
          /\ queue' = Append(Tail(queue), "R")
          /\ UNCHANGED <<status, promiseRef, sessionPhase, sessionCaptured, waitOrder>>
       \/ \* await pending 创建：挂成 waiter
          /\ promiseRef # "none"
          /\ status[promiseRef] = "creating"
          /\ rebuildCaptured' = promiseRef
          /\ rebuildPhase' = "waiting"
          /\ waitOrder' = IF sessionPhase = "waiting" /\ sessionCaptured = promiseRef
                          THEN "sessionFirst" ELSE "none"
          /\ UNCHANGED <<status, promiseRef, sessionPhase, sessionCaptured>>

(*** 两个入口挂在同一个 pending 创建上时，resolve 按挂接顺序入队 ***)
(*** createRouter 的 resolve 由任务（I/O）驱动：microtask 队列必须先清空 ***)
FinishCreate ==
    /\ queue = <<>>
    /\ \E r \in Routers :
         /\ status[r] = "creating"
         /\ LET sessionWaits == sessionPhase = "waiting" /\ sessionCaptured = r
                rebuildWaits == rebuildPhase = "waiting" /\ rebuildCaptured = r
                toAppend == IF sessionWaits /\ rebuildWaits
                            THEN IF waitOrder = "sessionFirst" THEN <<"S", "R">>
                                 ELSE IF waitOrder = "rebuildFirst" THEN <<"R", "S">>
                                 ELSE <<>>
                            ELSE IF sessionWaits THEN <<"S">>
                            ELSE IF rebuildWaits THEN <<"R">>
                            ELSE <<>>
            IN /\ status' = [status EXCEPT ![r] = "live"]
               /\ queue' = queue \o toAppend
               /\ sessionPhase' = IF sessionWaits THEN "queued" ELSE sessionPhase
               /\ rebuildPhase' = IF rebuildWaits THEN "queued" ELSE rebuildPhase
               /\ waitOrder' = IF sessionWaits \/ rebuildWaits THEN "none" ELSE waitOrder
               /\ UNCHANGED <<promiseRef, sessionCaptured, rebuildCaptured>>

-----------------------------------------------------------------------------
(*** ipc.ts:222-225 / 261-264：会话续体 ***)
(*** 若抓住的 Router 仍是当前 promise：dispose + 清空 → await getRouter() 新建；***)
(*** 已被别的入口替换：不碰新 Router，直接复用它。                          ***)
DrainSession ==
    /\ Len(queue) > 0
    /\ Head(queue) = "S"
    /\ sessionPhase = "queued"
    /\ queue' = Tail(queue)
    /\ IF sessionCaptured = "none"
       THEN \/ \* 入场时无 promise，getRouter() 直接新建
                 /\ promiseRef = "none"
                 /\ \E r \in Routers :
                      /\ status[r] = "unborn"
                      /\ status' = [status EXCEPT ![r] = "creating"]
                      /\ promiseRef' = r
                      /\ sessionPhase' = "idle"
                      /\ sessionCaptured' = "none"
                      /\ UNCHANGED <<rebuildPhase, rebuildCaptured, waitOrder>>
            \/ \* 窗口内别的入口已装上新 promise：getRouter() 复用它，不新建
                 /\ promiseRef # "none"
                 /\ sessionPhase' = "idle"
                 /\ sessionCaptured' = "none"
                 /\ UNCHANGED <<status, promiseRef, rebuildPhase, rebuildCaptured, waitOrder>>
       ELSE \/ \* 已被别的入口替换：不 dispose、不清空，getRouter() 复用
                 /\ promiseRef # sessionCaptured
                 /\ sessionPhase' = "idle"
                 /\ sessionCaptured' = "none"
                 /\ UNCHANGED <<status, promiseRef, rebuildPhase, rebuildCaptured, waitOrder>>
            \/ \* 仍是自己抓住的：dispose + 清空 + 新建
                 /\ promiseRef = sessionCaptured
                 /\ status[sessionCaptured] \in {"live", "disposed"}
                 /\ LET base == IF status[sessionCaptured] = "live"
                                THEN [status EXCEPT ![sessionCaptured] = "disposed"]
                                ELSE status
                    IN \E r \in Routers :
                         /\ base[r] = "unborn"
                         /\ status' = [base EXCEPT ![r] = "creating"]
                         /\ promiseRef' = r
                         /\ sessionPhase' = "idle"
                         /\ sessionCaptured' = "none"
                         /\ UNCHANGED <<rebuildPhase, rebuildCaptured, waitOrder>>

(*** ipc.ts:291-294：重建续体。已被替换 → 返回；isIdle 为假 → 返回；***)
(*** 仍是当前 promise 且空闲 → dispose + 清空 + 新建。                 ***)
DrainRebuild ==
    /\ Len(queue) > 0
    /\ Head(queue) = "R"
    /\ rebuildPhase = "queued"
    /\ queue' = Tail(queue)
    /\ \/ \* 已被别的入口替换：放弃重建，不碰新 Router
          /\ promiseRef # rebuildCaptured
          /\ rebuildPhase' = "idle"
          /\ rebuildCaptured' = "none"
          /\ UNCHANGED <<status, promiseRef, sessionPhase, sessionCaptured, waitOrder>>
       \/ /\ promiseRef = rebuildCaptured
          /\ status[rebuildCaptured] \in {"live", "disposed"}
          /\ \/ \* isIdle=false：忙碌，放弃本次重建
                /\ rebuildPhase' = "idle"
                /\ rebuildCaptured' = "none"
                /\ UNCHANGED <<status, promiseRef, sessionPhase, sessionCaptured, waitOrder>>
             \/ \* isIdle=true：dispose + 清空 + 新建
                /\ LET base == IF status[rebuildCaptured] = "live"
                               THEN [status EXCEPT ![rebuildCaptured] = "disposed"]
                               ELSE status
                   IN \E r \in Routers :
                        /\ base[r] = "unborn"
                        /\ status' = [base EXCEPT ![r] = "creating"]
                        /\ promiseRef' = r
                        /\ rebuildPhase' = "idle"
                        /\ rebuildCaptured' = "none"
                        /\ UNCHANGED <<sessionPhase, sessionCaptured, waitOrder>>

-----------------------------------------------------------------------------
Next ==
    \/ EnsureRouter
    \/ SessionEnterQueue
    \/ SessionEnterWait
    \/ QueueRebuildEntry
    \/ DrainRebuildEntry
    \/ FinishCreate
    \/ DrainSession
    \/ DrainRebuild

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(*** 不变量与性质 ***)

TypeOK ==
    /\ status \in [Routers -> {"unborn", "creating", "live", "disposed"}]
    /\ promiseRef \in Routers \cup {"none"}
    /\ sessionPhase \in {"idle", "waiting", "queued"}
    /\ sessionCaptured \in Routers \cup {"none"}
    /\ rebuildPhase \in {"idle", "waiting", "queued"}
    /\ rebuildCaptured \in Routers \cup {"none"}
    /\ queue \in Seq({"S", "R", "E"})
    /\ waitOrder \in {"none", "sessionFirst", "rebuildFirst"}

\* routerPromise 永不指向已 dispose 的 Router（清空与 dispose 在同一同步块）
PromiseRefNotDisposed ==
    IF promiseRef = "none" THEN TRUE ELSE status[promiseRef] # "disposed"

\* waiter 只可能挂在创建中的 Router 上（resolve 后必须已转入队列）
WaitingOnCreating ==
    /\ (sessionPhase = "waiting") => (status[sessionCaptured] = "creating")
    /\ (rebuildPhase = "waiting") => (status[rebuildCaptured] = "creating")

\* 两个入口同时 waiting 时必须记录了恢复顺序（模型自检，不是产品承诺）
BothWaitingOrdered ==
    (sessionPhase = "waiting" /\ rebuildPhase = "waiting") => (waitOrder # "none")

\* 同一时刻至多一个 Router 存活。存活 Router 各带一个 AgentSession、
\* 一条会话事件订阅、一套 MCP stdio 子进程与子代理桥；两个同时存活
\* 就是一份永不回收的资源 + 两个可能写同一会话文件的 session。
\* 身份校验回归会让这条性质变红（修复前的反例见 git 8db8e54）。
AtMostOneLive ==
    Cardinality({r \in Routers : status[r] = "live"}) <= 1

=============================================================================

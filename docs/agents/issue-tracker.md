# 项目 issue tracker

Tracker 为本地 Markdown/JSON 票据队列。本次 BF-01–05 的唯一执行入口为 [.scratch/confirmed-bug-fix-tickets/README.md](../../.scratch/confirmed-bug-fix-tickets/README.md)。标签 ready-for-agent 代表已分流；实施状态与验收证据写入 execution-state.json。

关闭方式：功能已合入集成分支、票内验收通过后，将票据标 resolved / implementationStatus=completed / verificationStatus=passed，记录提交和验收证据。无需 GitHub issue 或 PR。来源规格位于 plans/022-confirmed-bug-fixes/，不作为第二执行队列。

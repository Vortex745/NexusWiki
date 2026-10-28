# BF-02 confirmed testing seam

The human authorized implementation of BF-01–05 and confirmed S1–S4. BF-02 uses S2: real createApp, real authenticated HTTP GET /api/chat/runs/:runId, isolated in-memory SQLite conversation directory and trace storage. Only the external identity adapter supplies synthetic authenticated identities. No provider or business database is used.

Worktree: C:/Users/14253/.codex/bf-20261028/worktrees/bf-02. Branch: codex/bf-02. Before edits, HEAD and merge-base with codex/confirmed-bug-fixes were both 98846175afef3dad15005169cbb55493456eb423. The worktree was clean. CodeGraph reported that this isolated worktree has no index; built-in file tools were used afterward.

The first vertical slice is a cross-tenant HTTP request expecting the literal existing 404 response, with real persisted synthetic private reply and event content. Further controls will preserve owner, unlocked owner and trusted internal reads without treating a non-null session lock as ownership.

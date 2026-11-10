------------------------------ MODULE IngestionRetirement ------------------------------
\* One source, one document, one ingestion execution and four cleanup tasks.
\* Stage calls and cleanup calls have separate start/finish steps. An operation
\* already in flight can write after retirement, even if it ignores abort.
\* Cancellation and stale-claim recovery combined with that non-cooperative
\* operation are outside this model. They revoke the task before it settles.
EXTENDS Naturals

CONSTANTS FenceStages, FenceCompletion, WaitForIngest, FenceActivation

Stages == {"chunk", "wikify", "storeChunks", "storeGraph"}
CleanupOps == {"cleanup_es", "cleanup_neo4j", "cleanup_pageindex", "cleanup_images"}
NextStage == [chunk |-> "wikify", wikify |-> "storeChunks",
              storeChunks |-> "storeGraph", storeGraph |-> "complete"]
StageArtifacts == [chunk |-> {"cleanup_pageindex", "cleanup_images"},
                   wikify |-> {}, storeChunks |-> {"cleanup_es"},
                   storeGraph |-> {"cleanup_neo4j"}]

VARIABLES srcState, docState, taskState, nextStage, inFlight, operationFinished,
          artifacts, activeDoc, cleanupQueued, cleanupRunning, cleanupDone,
          completedAfterRetire, activatedAfterRetire, wroteAfterCleanup

vars == <<srcState, docState, taskState, nextStage, inFlight, operationFinished,
          artifacts, activeDoc, cleanupQueued, cleanupRunning, cleanupDone,
          completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

TypeOK ==
  /\ srcState \in {"active", "retired"}
  /\ docState \in {"none", "pending", "completed", "failed"}
  /\ taskState \in {"none", "pending", "running", "completed", "failed"}
  /\ nextStage \in Stages \cup {"complete"}
  /\ inFlight \in BOOLEAN
  /\ operationFinished \in BOOLEAN
  /\ artifacts \in [CleanupOps -> {"none", "present", "cleaned"}]
  /\ activeDoc \in {"none", "d1"}
  /\ cleanupQueued \in BOOLEAN
  /\ cleanupRunning \subseteq CleanupOps
  /\ cleanupDone \subseteq CleanupOps
  /\ cleanupRunning \cap cleanupDone = {}
  /\ completedAfterRetire \in BOOLEAN
  /\ activatedAfterRetire \in BOOLEAN
  /\ wroteAfterCleanup \in BOOLEAN

Init ==
  /\ srcState = "active"
  /\ docState = "none"
  /\ taskState = "none"
  /\ nextStage = "chunk"
  /\ inFlight = FALSE
  /\ operationFinished = FALSE
  /\ artifacts = [op \in CleanupOps |-> "none"]
  /\ activeDoc = "none"
  /\ cleanupQueued = FALSE
  /\ cleanupRunning = {}
  /\ cleanupDone = {}
  /\ completedAfterRetire = FALSE
  /\ activatedAfterRetire = FALSE
  /\ wroteAfterCleanup = FALSE

\* IngestionLifecycle.submit creates this source before it is retired.
Submit ==
  /\ srcState = "active"
  /\ docState = "none"
  /\ docState' = "pending"
  /\ taskState' = "pending"
  /\ UNCHANGED <<srcState, nextStage, inFlight, operationFinished, artifacts,
                activeDoc, cleanupQueued, cleanupRunning, cleanupDone,
                completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

\* TaskRepo.claimNext can claim a pending ingest even after retirement.
Claim ==
  /\ taskState = "pending"
  /\ taskState' = "running"
  /\ UNCHANGED <<srcState, docState, nextStage, inFlight, operationFinished,
                artifacts, activeDoc, cleanupQueued, cleanupRunning, cleanupDone,
                completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

\* TrackedStageExecution.runStage checks source/claim before starting the call.
StartStage ==
  /\ taskState = "running"
  /\ nextStage \in Stages
  /\ ~inFlight /\ ~operationFinished
  /\ (~FenceStages \/ srcState = "active")
  /\ inFlight' = TRUE
  /\ UNCHANGED <<srcState, docState, taskState, nextStage, operationFinished,
                artifacts, activeDoc, cleanupQueued, cleanupRunning, cleanupDone,
                completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

\* The external operation can finish after retirement. It has not returned
\* through the lifecycle boundary yet, so taskState stays running.
FinishOperation ==
  /\ inFlight
  /\ inFlight' = FALSE
  /\ operationFinished' = TRUE
  /\ artifacts' = [op \in CleanupOps |->
       IF op \in StageArtifacts[nextStage] THEN "present" ELSE artifacts[op]]
  /\ wroteAfterCleanup' = (wroteAfterCleanup \/
       (StageArtifacts[nextStage] /= {} /\ cleanupDone /= {}))
  /\ UNCHANGED <<srcState, docState, taskState, nextStage, activeDoc,
                cleanupQueued, cleanupRunning, cleanupDone,
                completedAfterRetire, activatedAfterRetire>>

\* The stage return guard runs before markDone and advancing nextStage.
FinishStage ==
  /\ taskState = "running"
  /\ operationFinished
  /\ (~FenceStages \/ srcState = "active")
  /\ nextStage' = NextStage[nextStage]
  /\ operationFinished' = FALSE
  /\ UNCHANGED <<srcState, docState, taskState, inFlight, artifacts, activeDoc,
                cleanupQueued, cleanupRunning, cleanupDone,
                completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

\* runNext success transaction checks source state before all final writes.
Complete ==
  /\ taskState = "running"
  /\ nextStage = "complete"
  /\ (~FenceCompletion \/ srcState = "active")
  /\ taskState' = "completed"
  /\ docState' = "completed"
  /\ activeDoc' = IF ~FenceActivation \/ srcState = "active" THEN "d1" ELSE activeDoc
  /\ completedAfterRetire' = (completedAfterRetire \/ srcState = "retired")
  /\ activatedAfterRetire' = (activatedAfterRetire \/
       (~FenceActivation /\ srcState = "retired"))
  /\ UNCHANGED <<srcState, nextStage, inFlight, operationFinished, artifacts,
                cleanupQueued, cleanupRunning, cleanupDone, wroteAfterCleanup>>

\* DocumentRepo.activate is also a public repository boundary. The source
\* predicate rejects a direct activation while retired, regardless of status.
Activate ==
  /\ docState /= "none"
  /\ activeDoc = "none"
  /\ (~FenceActivation \/ srcState = "active")
  /\ activeDoc' = "d1"
  /\ activatedAfterRetire' = (activatedAfterRetire \/ srcState = "retired")
  /\ UNCHANGED <<srcState, docState, taskState, nextStage, inFlight,
                operationFinished, artifacts, cleanupQueued, cleanupRunning,
                cleanupDone, completedAfterRetire, wroteAfterCleanup>>

\* runNext catches only after the awaited call settles. Retirement overrides
\* transient retry classification, so it never requeues this execution.
Fail ==
  /\ taskState = "running"
  /\ ~inFlight
  /\ taskState' = "failed"
  /\ docState' = "failed"
  /\ operationFinished' = FALSE
  /\ UNCHANGED <<srcState, nextStage, inFlight, artifacts, activeDoc,
                cleanupQueued, cleanupRunning, cleanupDone,
                completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

\* RetirementService.retire commits the terminal source state, then enqueues.
Retire ==
  /\ srcState = "active"
  /\ docState /= "none"
  /\ srcState' = "retired"
  /\ cleanupQueued' = TRUE
  /\ UNCHANGED <<docState, taskState, nextStage, inFlight, operationFinished,
                artifacts, activeDoc, cleanupRunning, cleanupDone,
                completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

\* TaskRepo.claimNext skips cleanup while that document has a running ingest.
ClaimCleanup(op) ==
  /\ srcState = "retired"
  /\ cleanupQueued
  /\ op \notin cleanupRunning \cup cleanupDone
  /\ (~WaitForIngest \/ taskState /= "running")
  /\ cleanupRunning' = cleanupRunning \cup {op}
  /\ UNCHANGED <<srcState, docState, taskState, nextStage, inFlight,
                operationFinished, artifacts, activeDoc, cleanupQueued,
                cleanupDone, completedAfterRetire, activatedAfterRetire,
                wroteAfterCleanup>>

\* ArtifactCleanupService.run removes the rows after its asynchronous call.
FinishCleanup(op) ==
  /\ op \in cleanupRunning
  /\ artifacts' = [artifacts EXCEPT ![op] = "cleaned"]
  /\ cleanupRunning' = cleanupRunning \ {op}
  /\ cleanupDone' = cleanupDone \cup {op}
  /\ UNCHANGED <<srcState, docState, taskState, nextStage, inFlight,
                operationFinished, activeDoc, cleanupQueued,
                completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

\* Existing lifecycle.retry refuses a retired source.
Retry ==
  /\ srcState = "active"
  /\ taskState = "failed"
  /\ docState' = "pending"
  /\ taskState' = "pending"
  /\ nextStage' = "chunk"
  /\ UNCHANGED <<srcState, inFlight, operationFinished, artifacts, activeDoc,
                cleanupQueued, cleanupRunning, cleanupDone,
                completedAfterRetire, activatedAfterRetire, wroteAfterCleanup>>

Done ==
  /\ taskState \in {"completed", "failed"}
  /\ (srcState = "active" \/ cleanupDone = CleanupOps)
  /\ UNCHANGED vars

Next == Submit \/ Claim \/ StartStage \/ FinishOperation \/ FinishStage \/ Complete
        \/ Activate \/ Fail \/ Retire \/ Retry \/ Done
        \/ (\E op \in CleanupOps: ClaimCleanup(op) \/ FinishCleanup(op))
Spec == Init /\ [][Next]_vars

CleanupOnlyAfterRetire == cleanupDone /= {} => srcState = "retired"
CompletedOnlyAfterStages == docState = "completed" => nextStage = "complete"
NoCompleteAfterRetire == ~completedAfterRetire
NoActivateAfterRetire == ~activatedAfterRetire
NoWriteAfterCleanup == ~wroteAfterCleanup /\
  (\A op \in cleanupDone: artifacts[op] = "cleaned")
CleanupDoesNotOvertakeWrite == cleanupRunning \cup cleanupDone /= {} => ~inFlight

=============================================================================

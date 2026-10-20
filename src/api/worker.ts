import { loadConfig } from "../config"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { type DB, openDb } from "../ingestion/tracking"
import { SyncRunService } from "../sync/sync_run_service"
import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import { WikiStore } from "../wiki/store"
import { WikiEngine, ModelWikiTopicGenerator, esWikiChunkReader } from "../wiki/engine"
import type { TracingRuntime } from "../tracing/contract"

let timer: NodeJS.Timeout | null = null

/**
 * T45: startWorker accepts a shared SQLite adapter from ProcessRuntime.
 * If no db is provided, falls back to the global openDb() cache (backward
 * compat for tests and CLI). The worker does not close the db — the caller
 * that owns ProcessRuntime is responsible for closing shared resources.
 */
export function startWorker(options: {
  db?: DB
  wikiChatClient?: OpenAI
  wikiElasticsearch?: Client
  pollIntervalMs?: number
  claimedTimeoutMs?: number
  ingestionConcurrency?: number
  /** LO-13: the process tracing runtime the worker executes tasks under. */
  tracing?: TracingRuntime
} = {}): { stop(): Promise<void> } {
  // Per-worker scheduling state (a module-level flag would leak across
  // concurrent startWorker() instances in tests and nested runtimes).
  let inFlightDrains = 0
  let sweeping = false
  let wikiBusy = false
  const cfg = loadConfig()
  const db = options.db ?? openDb()
  const lifecycle = createIngestionLifecycle(db, options.tracing ? { tracing: options.tracing } : undefined)
  const wikiStore = new WikiStore(db)
  const wikiEngine = options.wikiChatClient && options.wikiElasticsearch
    ? new WikiEngine(db, wikiStore, esWikiChunkReader(options.wikiElasticsearch, cfg.esChunkIndexName),
      new ModelWikiTopicGenerator(options.wikiChatClient, cfg.openaiChatModel))
    : null
  if (wikiEngine) wikiStore.recoverRunningJobs()

  const pollIntervalMs = options.pollIntervalMs ?? cfg.pollIntervalMs
  const claimedTimeoutMs = options.claimedTimeoutMs ?? cfg.claimedTimeoutMs
  // Ingestion speed: concurrent ingestion tasks (claimNext is transactional,
  // so concurrent drains never double-claim a task).
  const ingestionConcurrency = options.ingestionConcurrency ?? cfg.ingestionConcurrency ?? 2

  // Ticket 40 (SYNC-01B): pending sync work resumes safely after a restart —
  // runs that were 'running' when the previous process died are requeued.
  try {
    const recovered = new SyncRunService({ db, lifecycle }).recoverOnStartup()
    if (recovered > 0) {
      console.log(`[worker] Recovered ${recovered} interrupted sync run(s)`)
    }
  } catch (error) {
    console.warn(
      "[worker] Sync run recovery skipped:",
      error instanceof Error ? error.message : String(error)
    )
  }

  console.log(`[worker] Polling every ${pollIntervalMs}ms (concurrency ${ingestionConcurrency})`)

  const myTimer = setInterval(() => {
    lifecycle.recoverStaleClaims(claimedTimeoutMs)
    // Ticket 40 (SYNC-01B): sync scheduling rides the SAME worker timer —
    // recover expired leases, enqueue due scheduled sources and execute at
    // most one claimed run per tick. No new permanent service.
    if (!sweeping) {
      sweeping = true
      const syncRuns = new SyncRunService({ db, lifecycle })
      void syncRuns.sweep()
        .catch((error) => console.error("[worker] sync sweep failed:", error))
        .finally(() => {
          sweeping = false
        })
    }
    // Ingestion speed: fill every free drain slot. Each drain keeps claiming
    // until the queue is empty, so back-to-back tasks no longer pay one tick
    // of idle time between them.
    while (inFlightDrains < ingestionConcurrency) {
      inFlightDrains += 1
      void (async () => {
        try {
          for (;;) {
            const result = await lifecycle.runNext()
            if (!result) return
            if (result.success) {
              console.log(`[worker] Task ${result.taskId} completed`)
            } else if (result.cancelled) {
              console.log(`[worker] Task ${result.taskId} cancelled`)
            } else {
              console.error(`[worker] Task ${result.taskId} failed: ${result.error}`)
            }
          }
        } catch (error) {
          console.error("[worker] Error:", error)
        } finally {
          inFlightDrains -= 1
        }
      })()
    }
    if (wikiEngine && !wikiBusy) {
      wikiBusy = true
      void wikiEngine.runNext()
        .then((wikiJob) => {
          if (wikiJob) console.log(`[worker] Wiki task ${wikiJob.id} processed`)
        })
        .catch((error) => console.error("[worker] wiki task failed:", error))
        .finally(() => {
          wikiBusy = false
        })
    }
  }, pollIntervalMs)
  // Module-level `timer` keeps stopWorker()'s global kill switch working for
  // legacy callers; each instance still clears only its own timer on stop().
  timer = myTimer

  return {
    async stop(): Promise<void> {
      clearInterval(myTimer)
      if (timer === myTimer) timer = null
      // Wait for the active drains/sweep/wiki to finish so that graceful
      // shutdown doesn't interrupt an in-flight ingestion. Bounded by the
      // caller's shutdown timeout.
      while (inFlightDrains > 0 || sweeping || wikiBusy) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      try {
        await lifecycle.close()
      } catch (error) {
        console.warn(
          "[worker] Failed to close ingestion lifecycle:",
          error instanceof Error ? error.message : String(error)
        )
      }
    },
  }
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

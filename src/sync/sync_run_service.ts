/**
 * Ticket 40 (SYNC-01B) — schedule, claim and recover durable sync runs.
 *
 * The run table IS the durable work item, and the guarantees the ticket pins
 * live in three small mechanisms:
 *
 *  1. SCHEDULE without a new permanent service: each ACTIVE data source with
 *     a non-manual interval carries a stored `next_run_at`. The EXISTING
 *     worker timer calls {@link SyncRunService.sweep}, which enqueues due
 *     sources. No extra process, no extra long-lived loop.
 *  2. CLAIM exactly one active run per source: the partial unique index
 *     `idx_sync_runs_single_active` allows only one pending/running run per
 *     source, and a claim is a transactional UPDATE ... WHERE status =
 *     'pending' (changes === 1 = claimed). Concurrent triggers cannot create
 *     a second active run — the loser gets an explicit conflict.
 *  3. RECOVER pending work after a restart: pending rows are durable, and a
 *     'running' row whose lease expired is requeued by the sweep (startup
 *     requeues every running row, because the only process that could own it
 *     is gone). A FAILED run is a record, not a retried promise: it never
 *     touched the active version (ticket 39's failure isolation), so the
 *     prior version stays searchable until the next successful sync.
 *
 * Successful runs activate atomically because execution delegates to the
 * NORMAL ingestion lifecycle (submit + worker drain) — activation is the
 * lifecycle's own transactional step, never a separate write.
 */

import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"
import type { IngestionLifecycle } from "../ingestion/lifecycle"
import type { FetchOptions } from "../ingestion/url_fetcher"
import {
  SyncDataSourceService,
  SYNC_INTERVAL_MS,
  summarizePages,
  type SyncInterval,
  type SyncPageOutcome,
  type SyncPageFailureKind,
  type SyncMissingPage,
} from "./data_source_service"

export type SyncRunStatus = "pending" | "running" | "completed" | "failed"
export type SyncRunTrigger = "manual" | "schedule"

export interface SyncRun {
  id: string
  sourceId: string
  tenantId: string
  trigger: SyncRunTrigger
  status: SyncRunStatus
  summary: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export class SyncRunConflictError extends Error {
  constructor(readonly activeRunId: string) {
    super("another sync run is already active for this data source")
    this.name = "SyncRunConflictError"
  }
}

/** Ticket 41 (SYNC-02): one durable per-page outcome of a run (run-log). */
export interface SyncRunPage {
  runId: string
  uri: string
  status: "submitted" | "unchanged" | "failed" | "missing"
  failureKind: SyncPageFailureKind | null
  detail: string | null
  documentId: string | null
  version: number | null
  createdAt: string
}

interface SyncRunPageRow {
  run_id: string
  uri: string
  status: string
  failure_kind: string | null
  detail: string | null
  document_id: string | null
  version: number | null
  created_at: string
}

function rowToRunPage(row: SyncRunPageRow): SyncRunPage {
  return {
    runId: row.run_id,
    uri: row.uri,
    status: row.status as SyncRunPage["status"],
    failureKind: (row.failure_kind as SyncPageFailureKind | null) ?? null,
    detail: row.detail,
    documentId: row.document_id,
    version: row.version,
    createdAt: row.created_at,
  }
}

/** How long a claimed run may run before the sweep may requeue it. */
export const SYNC_RUN_LEASE_MS = 5 * 60_000

interface SyncRunRow {
  id: string
  source_id: string
  tenant_id: string
  trigger: string
  status: string
  summary: string | null
  error: string | null
  lease_expires_at: string | null
  created_at: string
  updated_at: string
}

function rowToRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    sourceId: row.source_id,
    tenantId: row.tenant_id,
    trigger: row.trigger as SyncRunTrigger,
    status: row.status as SyncRunStatus,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SyncRunService {
  constructor(
    private readonly options: {
      db: DB
      /** The normal ingestion lifecycle — sync execution drains through it. */
      lifecycle: IngestionLifecycle
      fetchOptions?: FetchOptions
      now?: () => Date
      leaseMs?: number
      maxPagesPerRun?: number
    }
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date()
  }

  private dataSourceService(): SyncDataSourceService {
    return new SyncDataSourceService({
      db: this.options.db,
      lifecycle: this.options.lifecycle,
      ...(this.options.fetchOptions ? { fetchOptions: this.options.fetchOptions } : {}),
      ...(this.options.maxPagesPerRun ? { maxPagesPerRun: this.options.maxPagesPerRun } : {}),
    })
  }

  listRuns(tenantId: string, sourceId: string, limit = 20): SyncRun[] {
    const rows = this.options.db
      .prepare(
        `SELECT * FROM sync_runs WHERE tenant_id = ? AND source_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(tenantId, sourceId, limit) as SyncRunRow[]
    return rows.map(rowToRun)
  }

  /**
   * Insert a pending run. The partial unique index makes this the claim
   * point: when a pending/running run already exists for the source, the
   * conflict is reported with the ACTIVE run id.
   */
  enqueue(tenantId: string, sourceId: string, trigger: SyncRunTrigger): SyncRun {
    const now = this.now().toISOString()
    const active = this.options.db
      .prepare(
        `SELECT id FROM sync_runs
         WHERE source_id = ? AND status IN ('pending','running')`
      )
      .get(sourceId) as { id: string } | undefined
    if (active) throw new SyncRunConflictError(active.id)
    const run: SyncRunRow = {
      id: randomUUID(),
      source_id: sourceId,
      tenant_id: tenantId,
      trigger,
      status: "pending",
      summary: null,
      error: null,
      lease_expires_at: null,
      created_at: now,
      updated_at: now,
    }
    this.options.db
      .prepare(
        `INSERT INTO sync_runs (
           id, source_id, tenant_id, trigger, status, summary, error,
           lease_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.source_id,
        run.tenant_id,
        run.trigger,
        run.status,
        run.summary,
        run.error,
        run.lease_expires_at,
        run.created_at,
        run.updated_at
      )
    return rowToRun(run)
  }

  /**
   * Startup recovery: requeue every 'running' row. A restart means the
   * previous owner is gone; pending work resumes on the next sweep.
   */
  recoverOnStartup(): number {
    const now = this.now().toISOString()
    const result = this.options.db
      .prepare(
        `UPDATE sync_runs SET status = 'pending', lease_expires_at = NULL, updated_at = ?
         WHERE status = 'running'`
      )
      .run(now)
    return result.changes
  }

  /** Requeue 'running' rows whose lease has expired (sweep-time safety). */
  recoverExpiredLeases(): number {
    const now = this.now().toISOString()
    const result = this.options.db
      .prepare(
        `UPDATE sync_runs SET status = 'pending', lease_expires_at = NULL, updated_at = ?
         WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
      )
      .run(now, now)
    return result.changes
  }

  /**
   * Enqueue due scheduled sources and roll their next_run_at forward. A
   * source whose active run already exists is skipped this sweep (its
   * next_run_at is NOT rolled, so it is retried on the next sweep).
   */
  enqueueDueScheduled(): number {
    const now = this.now()
    const sources = this.options.db
      .prepare(
        `SELECT id, tenant_id, interval FROM sync_data_sources
         WHERE state = 'active' AND interval != 'manual'
           AND (next_run_at IS NULL OR next_run_at <= ?)`
      )
      .all(now.toISOString()) as Array<{ id: string; tenant_id: string; interval: string }>
    let enqueued = 0
    for (const source of sources) {
      const intervalMs = SYNC_INTERVAL_MS[source.interval as Exclude<SyncInterval, "manual">]
      if (!intervalMs) continue
      try {
        this.enqueue(source.tenant_id, source.id, "schedule")
        enqueued += 1
      } catch (error) {
        if (error instanceof SyncRunConflictError) continue
        throw error
      }
      this.options.db
        .prepare(`UPDATE sync_data_sources SET next_run_at = ? WHERE id = ?`)
        .run(new Date(now.getTime() + intervalMs).toISOString(), source.id)
    }
    return enqueued
  }

  /**
   * Transactional claim of the oldest pending run. `changes === 1` is the
   * whole claim — two concurrent claimers can never both win because the
   * UPDATE only matches the row while it is still 'pending'.
   */
  claimNext(): SyncRun | null {
    const now = this.now()
    const leaseExpires = new Date(
      now.getTime() + (this.options.leaseMs ?? SYNC_RUN_LEASE_MS)
    ).toISOString()
    return this.options.db.transaction((): SyncRun | null => {
      const row = this.options.db
        .prepare(
          `SELECT * FROM sync_runs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
        )
        .get() as SyncRunRow | undefined
      if (!row) return null
      const result = this.options.db
        .prepare(
          `UPDATE sync_runs
           SET status = 'running', lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(leaseExpires, now.toISOString(), row.id)
      if (result.changes !== 1) return null
      const claimed = this.options.db
        .prepare(`SELECT * FROM sync_runs WHERE id = ?`)
        .get(row.id) as SyncRunRow
      return rowToRun(claimed)
    })()
  }

  /**
   * Execute a claimed run through the module-owned sync service and the
   * NORMAL ingestion lifecycle, then finalize. A failure marks the run
   * failed — the active version was never touched (ticket 39 isolation).
   *
   * Ticket 41 (SYNC-02): every page outcome is persisted to `sync_run_pages`
   * (the run-log detail view), and the summary headline carries the failure
   * kind breakdown so list/detail views can distinguish timeout, rate limit
   * and invalid URL from generic failures without re-reading pages.
   */
  async executeClaimed(run: SyncRun): Promise<SyncRun> {
    const finalize = (status: SyncRunStatus, fields: { summary?: string; error?: string }) => {
      this.options.db
        .prepare(
          `UPDATE sync_runs SET status = ?, summary = ?, error = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          status,
          fields.summary ?? null,
          fields.error ?? null,
          this.now().toISOString(),
          run.id
        )
      const row = this.options.db
        .prepare(`SELECT * FROM sync_runs WHERE id = ?`)
        .get(run.id) as SyncRunRow
      return rowToRun(row)
    }
    try {
      const report = await this.dataSourceService().runOnce(run.tenantId, run.sourceId)
      await this.drainLifecycle()
      this.persistRunPages(run.id, report.pages, report.missing ?? [])
      const failedPages = report.pages.filter((page) => page.status === "failed")
      const summary = summarizePages(report.pages, report.missing)
      if (failedPages.length > 0) {
        // The durable run record names WHAT failed, bounded like every field.
        const detail = failedPages
          .map((page) => `${page.uri}: ${page.detail ?? "failed"}`)
          .join("; ")
          .slice(0, 300)
        return report.pages.every((page) => page.status === "failed")
          ? finalize("failed", { error: `${summary} — ${detail}` })
          : finalize("completed", { summary: `${summary} — ${detail}` })
      }
      return finalize("completed", { summary })
    } catch (error) {
      return finalize("failed", {
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      })
    }
  }

  /**
   * Ticket 41 (SYNC-02): the durable run-log. One row per page outcome so a
   * detail view can distinguish success/unchanged/timeout/rate limit/
   * invalid URL without reconstructing anything, plus one 'missing' row per
   * page that disappeared from a successful sitemap read.
   */
  private persistRunPages(
    runId: string,
    pages: SyncPageOutcome[],
    missing: SyncMissingPage[]
  ): void {
    const createdAt = this.now().toISOString()
    const insert = this.options.db.prepare(
      `INSERT INTO sync_run_pages (
         run_id, uri, status, failure_kind, detail, document_id, version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.options.db.transaction(() => {
      for (const page of pages) {
        insert.run(
          runId,
          page.uri,
          page.status,
          page.failureKind ?? null,
          page.detail ?? null,
          page.documentId ?? null,
          page.version ?? null,
          createdAt
        )
      }
      for (const miss of missing) {
        insert.run(
          runId,
          miss.uri,
          "missing",
          null,
          `missing from sitemap (consecutive miss ${miss.missCount}${miss.pendingRetirement ? ", pending retirement" : ""})`,
          null,
          null,
          createdAt
        )
      }
    })()
  }

  /** Ticket 41 (SYNC-02): one run of this source, tenant-scoped. */
  getRun(tenantId: string, sourceId: string, runId: string): SyncRun | null {
    const row = this.options.db
      .prepare(
        `SELECT * FROM sync_runs
         WHERE tenant_id = ? AND source_id = ? AND id = ?`
      )
      .get(tenantId, sourceId, runId) as SyncRunRow | undefined
    return row ? rowToRun(row) : null
  }

  /** Ticket 41 (SYNC-02): the per-page outcomes of one run (run-log view). */
  listRunPages(runId: string): SyncRunPage[] {
    const rows = this.options.db
      .prepare(
        `SELECT * FROM sync_run_pages WHERE run_id = ? ORDER BY uri ASC`
      )
      .all(runId) as SyncRunPageRow[]
    return rows.map(rowToRunPage)
  }

  /** The worker path: drain ingested sync output to ACTIVE. */
  private async drainLifecycle(): Promise<void> {
    while (await this.options.lifecycle.runNext()) {
      // keep draining
    }
  }

  /**
   * One manual trigger: enqueue (conflict → 409 semantics), claim and run to
   * completion. The claimed run is THIS call's run — a concurrent trigger
   * for the same source is the one that lost the enqueue/claim.
   */
  async runNow(tenantId: string, sourceId: string): Promise<SyncRun> {
    const run = this.enqueue(tenantId, sourceId, "manual")
    const claimed = this.claimById(run.id)
    if (!claimed) throw new SyncRunConflictError(run.id)
    return this.executeClaimed(claimed)
  }

  private claimById(id: string): SyncRun | null {
    const now = this.now()
    const leaseExpires = new Date(
      now.getTime() + (this.options.leaseMs ?? SYNC_RUN_LEASE_MS)
    ).toISOString()
    const result = this.options.db
      .prepare(
        `UPDATE sync_runs
         SET status = 'running', lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(leaseExpires, now.toISOString(), id)
    if (result.changes !== 1) return null
    const row = this.options.db.prepare(`SELECT * FROM sync_runs WHERE id = ?`).get(id) as SyncRunRow
    return rowToRun(row)
  }

  /**
   * One worker-tick slice of sync scheduling: recover expired leases, enqueue
   * due scheduled sources, then run at most ONE claimed run to completion.
   * Called from the EXISTING worker timer — no new permanent service.
   */
  async sweep(): Promise<void> {
    this.recoverExpiredLeases()
    this.enqueueDueScheduled()
    const claimed = this.claimNext()
    if (claimed) await this.executeClaimed(claimed)
  }
}

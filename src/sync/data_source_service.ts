/**
 * Ticket 39 (SYNC-01A) — the URL/sitemap data-source module.
 *
 * One service owns the data-source lifecycle and the ONE safe sync:
 *
 *  - A data source binds ONE resource (a URL or a sitemap) to exactly ONE
 *    knowledge base, with an interval choice (manual / 1h / 6h / 24h) and an
 *    operator lifecycle (active / paused). Interval scheduling itself is
 *    ticket 40; this module stores the choice and runs MANUAL syncs.
 *  - A sync REUSES the safe fetching the import path is held to
 *    (fetchSingleUrl / fetchSitemapUrls: private-network denies, redirect
 *    re-validation, per-hop timeouts, streamed size caps) and pushes what it
 *    read through the NORMAL ingestion lifecycle (submit → worker →
 *    candidate-to-active). No second ingestion implementation exists.
 *  - Idempotency: the lifecycle's content-hash check returns "unchanged" for
 *    identical content — no duplicate document version is created.
 *  - Failure isolation: a timeout, a policy deny or a fetch failure means
 *    NOTHING is submitted for that resource, so the previous active version
 *    stays indexed and searchable. The failure is recorded on the data
 *    source (last_sync_status), never swallowed.
 */

import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"
import {
  fetchSitemapUrls,
  fetchSingleUrl,
  UrlPolicyDenyError,
  type FetchOptions,
} from "../ingestion/url_fetcher"
import type { IngestionLifecycle, IngestionSubmission } from "../ingestion/lifecycle"
import { htmlToText } from "../web/web_evidence"

export type SyncSourceKind = "url" | "sitemap"
export type SyncInterval = "manual" | "1h" | "6h" | "24h"
export type SyncSourceState = "active" | "paused"

export interface SyncDataSource {
  id: string
  tenantId: string
  knowledgeBaseId: string
  kind: SyncSourceKind
  uri: string
  interval: SyncInterval
  state: SyncSourceState
  title: string
  lastSyncAt: string | null
  lastSyncStatus: string | null
  createdAt: string
  updatedAt: string
}

export interface SyncPageOutcome {
  uri: string
  status: "submitted" | "unchanged" | "failed"
  detail?: string
  documentId?: string
  version?: number
}

export interface SyncRunReport {
  dataSourceId: string
  kind: SyncSourceKind
  pages: SyncPageOutcome[]
  /** Honest truncation note for a sitemap larger than one sync window. */
  truncated?: boolean
  startedAt: string
  finishedAt: string
}

export class SyncSourceNotFoundError extends Error {
  constructor() {
    super("sync data source not found")
    this.name = "SyncSourceNotFoundError"
  }
}

export class InvalidSyncSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidSyncSourceError"
  }
}

export const SYNC_INTERVALS: readonly SyncInterval[] = ["manual", "1h", "6h", "24h"]
/** Bounded sync window: a sitemap sync reads at most this many pages. */
export const SYNC_MAX_PAGES_PER_RUN = 10
const SYNC_FETCH_TIMEOUT_MS = 20_000
const SYNC_FETCH_MAX_BYTES = 5 * 1024 * 1024

interface SyncSourceRow {
  id: string
  tenant_id: string
  knowledge_base_id: string
  kind: string
  uri: string
  interval: string
  state: string
  title: string
  last_sync_at: string | null
  last_sync_status: string | null
  created_at: string
  updated_at: string
}

function rowToSource(row: SyncSourceRow): SyncDataSource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    knowledgeBaseId: row.knowledge_base_id,
    kind: row.kind as SyncSourceKind,
    uri: row.uri,
    interval: row.interval as SyncInterval,
    state: row.state as SyncSourceState,
    title: row.title,
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SyncDataSourceService {
  constructor(
    private readonly options: {
      db: DB
      lifecycle: IngestionLifecycle
      fetchOptions?: FetchOptions
      now?: () => Date
      /** Sync page cap override (tests). */
      maxPagesPerRun?: number
    }
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date()
  }

  create(input: {
    tenantId: string
    knowledgeBaseId: string
    kind: SyncSourceKind
    uri: string
    interval?: SyncInterval
    title?: string
  }): SyncDataSource {
    const kind = input.kind
    if (kind !== "url" && kind !== "sitemap") {
      throw new InvalidSyncSourceError('kind must be "url" or "sitemap"')
    }
    let uri: URL
    try {
      uri = new URL(input.uri)
    } catch {
      throw new InvalidSyncSourceError("uri must be an absolute URL")
    }
    if (uri.protocol !== "http:" && uri.protocol !== "https:") {
      throw new InvalidSyncSourceError("only http(s) resources can be synced")
    }
    const interval = input.interval ?? "manual"
    if (!SYNC_INTERVALS.includes(interval)) {
      throw new InvalidSyncSourceError(`interval must be one of ${SYNC_INTERVALS.join(", ")}`)
    }
    const now = this.now().toISOString()
    const row: SyncSourceRow = {
      id: randomUUID(),
      tenant_id: input.tenantId,
      knowledge_base_id: input.knowledgeBaseId,
      kind,
      uri: uri.toString(),
      interval,
      state: "active",
      title: (input.title ?? uri.hostname).slice(0, 200),
      last_sync_at: null,
      last_sync_status: null,
      created_at: now,
      updated_at: now,
    }
    this.options.db
      .prepare(
        `INSERT INTO sync_data_sources (
           id, tenant_id, knowledge_base_id, kind, uri, interval, state,
           title, last_sync_at, last_sync_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.tenant_id,
        row.knowledge_base_id,
        row.kind,
        row.uri,
        row.interval,
        row.state,
        row.title,
        row.last_sync_at,
        row.last_sync_status,
        row.created_at,
        row.updated_at
      )
    return rowToSource(row)
  }

  list(tenantId: string, knowledgeBaseId?: string): SyncDataSource[] {
    const rows = (
      knowledgeBaseId !== undefined
        ? this.options.db
            .prepare(
              `SELECT * FROM sync_data_sources
               WHERE tenant_id = ? AND knowledge_base_id = ?
               ORDER BY created_at DESC`
            )
            .all(tenantId, knowledgeBaseId)
        : this.options.db
            .prepare(`SELECT * FROM sync_data_sources WHERE tenant_id = ? ORDER BY created_at DESC`)
            .all(tenantId)
    ) as SyncSourceRow[]
    return rows.map(rowToSource)
  }

  get(tenantId: string, id: string): SyncDataSource {
    const row = this.options.db
      .prepare(`SELECT * FROM sync_data_sources WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, id) as SyncSourceRow | undefined
    if (!row) throw new SyncSourceNotFoundError()
    return rowToSource(row)
  }

  /** Operator lifecycle updates: the interval choice and the active/paused state. */
  update(
    tenantId: string,
    id: string,
    patch: { interval?: SyncInterval; state?: SyncSourceState }
  ): SyncDataSource {
    const existing = this.get(tenantId, id)
    if (patch.interval !== undefined && !SYNC_INTERVALS.includes(patch.interval)) {
      throw new InvalidSyncSourceError(`interval must be one of ${SYNC_INTERVALS.join(", ")}`)
    }
    if (patch.state !== undefined && patch.state !== "active" && patch.state !== "paused") {
      throw new InvalidSyncSourceError('state must be "active" or "paused"')
    }
    this.options.db
      .prepare(
        `UPDATE sync_data_sources
         SET interval = ?, state = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.interval ?? existing.interval,
        patch.state ?? existing.state,
        this.now().toISOString(),
        id
      )
    return this.get(tenantId, id)
  }

  /**
   * Retire a data source: the row is removed, but nothing that was already
   * ingested from it is touched — the documents stay as they are.
   */
  delete(tenantId: string, id: string): void {
    this.get(tenantId, id)
    this.options.db.prepare(`DELETE FROM sync_data_sources WHERE id = ?`).run(id)
  }

  private recordSyncOutcome(id: string, status: string): void {
    const now = this.now().toISOString()
    this.options.db
      .prepare(
        `UPDATE sync_data_sources
         SET last_sync_at = ?, last_sync_status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(now, status.slice(0, 200), now, id)
  }

  /**
   * Fetch the resource safely and submit what was read through the NORMAL
   * ingestion lifecycle. Failures submit nothing — the previous active
   * version stays searchable — and are recorded, never swallowed.
   */
  async runOnce(
    tenantId: string,
    id: string,
    runOptions: { signal?: AbortSignal } = {}
  ): Promise<SyncRunReport> {
    const source = this.get(tenantId, id)
    if (source.state !== "active") {
      throw new InvalidSyncSourceError("a paused data source cannot be synced")
    }
    const startedAt = this.now().toISOString()
    const fetchOptions: FetchOptions = {
      timeoutMs: SYNC_FETCH_TIMEOUT_MS,
      maxBytes: SYNC_FETCH_MAX_BYTES,
      ...(this.options.fetchOptions ?? {}),
    }
    const maxPages = this.options.maxPagesPerRun ?? SYNC_MAX_PAGES_PER_RUN
    const pages: SyncPageOutcome[] = []
    let truncated = false

    const submitPage = async (pageUrl: URL): Promise<void> => {
      try {
        const fetched = await fetchSingleUrl(pageUrl, fetchOptions)
        const mimeType = fetched.mimeType.toLowerCase()
        const raw = fetched.buffer.toString("utf8")
        const isHtml = mimeType.includes("html")
        const content = isHtml ? htmlToText(raw) : raw
        if (content.trim().length === 0) {
          pages.push({ uri: fetched.url.toString(), status: "failed", detail: "empty content" })
          return
        }
        const submission: IngestionSubmission = this.options.lifecycle.submit({
          title: fetched.title ?? fetched.url.hostname,
          content,
          mimeType: isHtml ? "text/plain" : mimeType,
          knowledgeBaseId: source.knowledgeBaseId,
          // Re-syncing the SAME resource with changed content is a new
          // version of that resource — never a detached document.
          versionIntent: "new_version",
          sourceIdentity: {
            kind: "url",
            uriOrExternalId: fetched.url.toString(),
            namespace: "sync",
            tenantId,
          },
        })
        pages.push({
          uri: fetched.url.toString(),
          status: submission.status === "unchanged" ? "unchanged" : "submitted",
          documentId: submission.docId,
          version: submission.version,
        })
      } catch (error) {
        if (runOptions.signal?.aborted) {
          throw new Error("sync cancelled")
        }
        pages.push({
          uri: pageUrl.toString(),
          status: "failed",
          detail: (error instanceof UrlPolicyDenyError
            ? `policy denied: ${error.decision.reason}`
            : (error instanceof Error ? error.message : String(error))
          ).slice(0, 200),
        })
      }
    }

    try {
      if (source.kind === "url") {
        await submitPage(new URL(source.uri))
      } else {
        const sitemap = await fetchSitemapUrls(new URL(source.uri), {
          ...fetchOptions,
          maxPages,
        })
        if (sitemap.length >= maxPages) truncated = true
        for (const page of sitemap) {
          await submitPage(page.url)
        }
      }
    } finally {
      const failed = pages.filter((page) => page.status === "failed").length
      const unchanged = pages.filter((page) => page.status === "unchanged").length
      const submitted = pages.filter((page) => page.status === "submitted").length
      const summary =
        pages.length === 0
          ? "no pages read"
          : `submitted=${submitted} unchanged=${unchanged} failed=${failed}`
      this.recordSyncOutcome(source.id, summary)
    }

    return {
      dataSourceId: source.id,
      kind: source.kind,
      pages,
      ...(truncated ? { truncated } : {}),
      startedAt,
      finishedAt: this.now().toISOString(),
    }
  }
}

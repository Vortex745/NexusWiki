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
import type { TaskTraceContext } from "../tracing/contract"
import { htmlToText } from "../web/web_evidence"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import {
  RetirementServiceImpl,
  type RetirementResult,
} from "../knowledge/retirement"
import { SqliteSourceLifecycleStore } from "../knowledge/source_lifecycle_store"

export type SyncSourceKind = "url" | "sitemap"
export type SyncInterval = "manual" | "1h" | "6h" | "24h"
export type SyncSourceState = "active" | "paused"

/**
 * Ticket 41 (SYNC-02): machine-readable page-failure classification. The
 * run-log must distinguish success/unchanged from TIMEOUT, RATE LIMIT and
 * INVALID URL — a free-form detail string alone cannot be filtered or
 * counted reliably, so every failed page also carries one of these kinds.
 */
export type SyncPageFailureKind =
  | "timeout"
  | "rate_limit"
  | "invalid_url"
  | "policy_denied"
  | "http_error"
  | "network"
  | "empty"

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
  /** Ticket 41 (SYNC-02): machine-readable failure classification. */
  failureKind?: SyncPageFailureKind
  documentId?: string
  version?: number
}

/** Ticket 41 (SYNC-02): one missing-page observation in a sitemap run. */
export interface SyncMissingPage {
  uri: string
  missCount: number
  /** True when THIS observation completed the second consecutive miss. */
  pendingRetirement: boolean
}

export interface SyncRunReport {
  dataSourceId: string
  kind: SyncSourceKind
  pages: SyncPageOutcome[]
  /** Honest truncation note for a sitemap larger than one sync window. */
  truncated?: boolean
  /** Ticket 41 (SYNC-02): pages absent from this successful sitemap read. */
  missing?: SyncMissingPage[]
  startedAt: string
  finishedAt: string
}

/**
 * Ticket 41 (SYNC-02): classify a fetch failure the way the run-log view
 * must present it. Ordered by specificity — policy denies and timeouts are
 * named errors; "http 429" is a rate limit before generic http errors; an
 * unparseable redirect target is an invalid URL; everything else is network.
 */
export function classifyPageFailure(error: unknown): SyncPageFailureKind {
  if (error instanceof UrlPolicyDenyError) return "policy_denied"
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("invalid redirect Location")) return "invalid_url"
  if (message.includes("timeout after") || message.includes("body_read_timeout")) {
    return "timeout"
  }
  if (/\bhttp 429\b/.test(message)) return "rate_limit"
  if (/\bhttp \d{3}\b/.test(message)) return "http_error"
  return "network"
}

/** How many consecutive missing-page observations mark content pending. */
export const SYNC_MISSES_UNTIL_PENDING = 2

/**
 * Ticket 41 (SYNC-02): the ONE summary shape for a sync run — used for the
 * source's last_sync_status AND the durable run row, so list views and run
 * views never disagree. Failure kinds are grouped and ordered
 * deterministically; missing pages count only when observed.
 */
export function summarizePages(
  pages: SyncPageOutcome[],
  missing: SyncMissingPage[] | undefined
): string {
  if (pages.length === 0 && !(missing && missing.length > 0)) return "no pages read"
  const failedPages = pages.filter((page) => page.status === "failed")
  const base =
    `submitted=${pages.filter((page) => page.status === "submitted").length} ` +
    `unchanged=${pages.filter((page) => page.status === "unchanged").length} ` +
    `failed=${failedPages.length}` +
    (missing && missing.length > 0 ? ` missing=${missing.length}` : "")
  if (failedPages.length === 0) return base
  const counts = new Map<SyncPageFailureKind, number>()
  for (const page of failedPages) {
    const kind: SyncPageFailureKind = page.failureKind ?? "network"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const breakdown = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(" ")
  return `${base} (${breakdown})`
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

/** Ticket 41 (SYNC-02): the page is not tracked by this data source (404). */
export class SyncPageNotFoundError extends Error {
  constructor() {
    super("page is not tracked for this data source")
    this.name = "SyncPageNotFoundError"
  }
}

/**
 * Ticket 41 (SYNC-02): the page exists but retirement cannot proceed — it is
 * not pending (fewer than two consecutive misses), or it has no linked
 * content to retire. A state conflict, not a bad request (409).
 */
export class SyncPageRetirementConflictError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "SyncPageRetirementConflictError"
  }
}

export const SYNC_INTERVALS: readonly SyncInterval[] = ["manual", "1h", "6h", "24h"]
/** Milliseconds behind each schedulable interval choice (ticket 40). */
export const SYNC_INTERVAL_MS: Record<Exclude<SyncInterval, "manual">, number> = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
}
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

/** Ticket 41 (SYNC-02): one row of the per-source missing-page ledger. */
export interface SyncSourcePage {
  sourceId: string
  tenantId: string
  uri: string
  /** The ingestion Source row this page's content lives under. */
  ingestSourceId: string | null
  documentId: string | null
  lastSeenAt: string | null
  missCount: number
  retirementState: "none" | "pending_retirement" | "retired"
  updatedAt: string
}

interface SyncSourcePageRow {
  source_id: string
  tenant_id: string
  uri: string
  ingest_source_id: string | null
  document_id: string | null
  last_seen_at: string | null
  miss_count: number
  retirement_state: string
  updated_at: string
}

function rowToPage(row: SyncSourcePageRow): SyncSourcePage {
  return {
    sourceId: row.source_id,
    tenantId: row.tenant_id,
    uri: row.uri,
    ingestSourceId: row.ingest_source_id,
    documentId: row.document_id,
    lastSeenAt: row.last_seen_at,
    missCount: row.miss_count,
    retirementState: row.retirement_state as SyncSourcePage["retirementState"],
    updatedAt: row.updated_at,
  }
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

  /** Ticket 40 (SYNC-01B): the stored next-run state of one source. */
  private getNextRunAt(id: string): string | null {
    const row = this.options.db
      .prepare(`SELECT next_run_at FROM sync_data_sources WHERE id = ?`)
      .get(id) as { next_run_at: string | null } | undefined
    return row?.next_run_at ?? null
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
    // Ticket 40 (SYNC-01B): an interval change re-rolls the stored next-run
    // state from now. "manual" never schedules (next_run_at cleared); an
    // unchanged interval keeps its existing schedule.
    let nextRunAt: string | null = this.getNextRunAt(id)
    if (patch.interval !== undefined) {
      nextRunAt =
        patch.interval === "manual"
          ? null
          : new Date(this.now().getTime() + SYNC_INTERVAL_MS[patch.interval]).toISOString()
    }
    this.options.db
      .prepare(
        `UPDATE sync_data_sources
         SET interval = ?, state = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.interval ?? existing.interval,
        patch.state ?? existing.state,
        nextRunAt,
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
    runOptions: {
      signal?: AbortSignal
      trace?: TaskTraceContext
      assertCurrentClaim?: () => void
    } = {}
  ): Promise<SyncRunReport> {
    runOptions.assertCurrentClaim?.()
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
    // Ticket 41 (SYNC-02): missing-page observations from a successful
    // sitemap read (undefined for url sources / failed reads).
    let missing: SyncMissingPage[] | undefined
    // Outcome per URI — lets the ledger link pages to their content.
    const pageOutcomeByUri = new Map<string, SyncPageOutcome>()

    const submitPage = async (pageUrl: URL): Promise<void> => {
      try {
        const fetched = await fetchSingleUrl(pageUrl, fetchOptions)
        runOptions.assertCurrentClaim?.()
        const mimeType = fetched.mimeType.toLowerCase()
        const raw = fetched.buffer.toString("utf8")
        const isHtml = mimeType.includes("html")
        const content = isHtml ? htmlToText(raw) : raw
        if (content.trim().length === 0) {
          pages.push({
            uri: fetched.url.toString(),
            status: "failed",
            failureKind: "empty",
            detail: "empty content",
          })
          pageOutcomeByUri.set(fetched.url.toString(), pages[pages.length - 1])
          return
        }
        const submission: IngestionSubmission = this.options.lifecycle.submit({
          // LO-15: derived ingestion continues the sync run's trace.
          ...(runOptions.trace ? { trace: runOptions.trace } : {}),
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
        // Both the listing URL and the final (post-redirect) URL map to this
        // outcome — the ledger is keyed by the LISTING URL, so a redirecting
        // page must still link to its content (review M-1).
        pageOutcomeByUri.set(pageUrl.toString(), pages[pages.length - 1])
        pageOutcomeByUri.set(fetched.url.toString(), pages[pages.length - 1])
      } catch (error) {
        runOptions.assertCurrentClaim?.()
        if (runOptions.signal?.aborted) {
          throw new Error("sync cancelled")
        }
        pages.push({
          uri: pageUrl.toString(),
          status: "failed",
          // Ticket 41 (SYNC-02): the run-log distinguishes timeout,
          // rate limit and invalid URL from generic failures.
          failureKind: classifyPageFailure(error),
          detail: (error instanceof UrlPolicyDenyError
            ? `policy denied: ${error.decision.reason}`
            : (error instanceof Error ? error.message : String(error))
          ).slice(0, 200),
        })
        pageOutcomeByUri.set(pageUrl.toString(), pages[pages.length - 1])
      }
    }

    try {
      if (source.kind === "url") {
        await submitPage(new URL(source.uri))
        runOptions.assertCurrentClaim?.()
      } else {
        const sitemap = await fetchSitemapUrls(new URL(source.uri), {
          ...fetchOptions,
          maxPages,
        })
        runOptions.assertCurrentClaim?.()
        // Honest truncation: the listing is capped only when the sitemap
        // parsed MORE than the window (length === maxPages alone is not
        // truncation).
        if (sitemap.parsedCount > sitemap.urls.length) truncated = true
        if (sitemap.urls.length === 0) {
          // A 200 response that parses to ZERO URLs is a garbage/failed read,
          // not an empty source — counting every tracked page missing on it
          // would fabricate retirements (ticket 41 review m-4).
          throw new Error("sitemap parsed zero URLs; treating the read as failed")
        }
        for (const page of sitemap.urls) {
          await submitPage(page.url)
          runOptions.assertCurrentClaim?.()
        }
        // Ticket 41 (SYNC-02): the sitemap read SUCCEEDED — this is the only
        // moment missing pages are observable. Pages seen before but absent
        // from this listing accumulate a miss; the SECOND consecutive miss
        // marks them 'pending_retirement'. Content stays searchable until an
        // administrator explicitly confirms retirement. A TRUNCATED read is
        // NOT a complete listing — folding it into the ledger would count
        // pages beyond the window as missing (review B-1), so it is skipped.
        if (!truncated) {
          runOptions.assertCurrentClaim?.()
          missing = this.recordPageObservations(
            source,
            sitemap.urls.map((p) => p.url.toString()),
            pageOutcomeByUri
          )
        }
      }
    } finally {
      runOptions.assertCurrentClaim?.()
      this.recordSyncOutcome(source.id, summarizePages(pages, missing))
    }

    return {
      dataSourceId: source.id,
      kind: source.kind,
      pages,
      ...(truncated ? { truncated } : {}),
      ...(missing && missing.length > 0 ? { missing } : {}),
      startedAt,
      finishedAt: this.now().toISOString(),
    }
  }

  /**
   * Ticket 41 (SYNC-02): fold ONE successful sitemap observation into the
   * per-page ledger. Pages in the listing are seen (miss counter RESETS — a
   * temporary miss must never retire content, and a page that returns is
   * back in good standing); known pages absent from the listing accumulate
   * a miss and reach 'pending_retirement' on the SECOND consecutive one.
   */
  private recordPageObservations(
    source: SyncDataSource,
    listedUris: string[],
    pageOutcomeByUri: Map<string, SyncPageOutcome>
  ): SyncMissingPage[] {
    const now = this.now().toISOString()
    const seen = new Set(listedUris)
    const known = this.options.db
      .prepare(`SELECT uri FROM sync_source_pages WHERE source_id = ?`)
      .all(source.id) as Array<{ uri: string }>

    const missing: SyncMissingPage[] = []
    for (const row of known) {
      if (seen.has(row.uri)) continue
      if (this.isRetiredRow(source.id, row.uri)) continue
      const result = this.options.db
        .prepare(
          `UPDATE sync_source_pages
           SET miss_count = miss_count + 1,
               retirement_state = CASE WHEN miss_count + 1 >= ? THEN 'pending_retirement' ELSE retirement_state END,
               updated_at = ?
           WHERE source_id = ? AND uri = ?
             AND retirement_state != 'retired'
             AND ingest_source_id IS NOT NULL`
        )
        .run(SYNC_MISSES_UNTIL_PENDING, now, source.id, row.uri)
      if (result.changes === 1) {
        const after = this.getPageRow(source.id, row.uri)
        missing.push({
          uri: row.uri,
          missCount: after?.missCount ?? 1,
          pendingRetirement: after?.retirementState === "pending_retirement",
        })
      }
    }

    for (const uri of listedUris) {
      // Seen: the miss counter RESETS; a pending_retirement page that came
      // back is back in good standing ('retired' stays terminal).
      this.options.db
        .prepare(
          `INSERT INTO sync_source_pages (
             source_id, tenant_id, uri, ingest_source_id, document_id,
             last_seen_at, miss_count, retirement_state, updated_at
           ) VALUES (?, ?, ?, NULL, NULL, ?, 0, 'none', ?)
           ON CONFLICT(source_id, uri) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             miss_count = 0,
             retirement_state = CASE
               WHEN sync_source_pages.retirement_state = 'pending_retirement' THEN 'none'
               ELSE sync_source_pages.retirement_state END,
             updated_at = excluded.updated_at`
        )
        .run(source.id, source.tenantId, uri, now, now)
      // Remember which ingestion Source/document owns this page so a later
      // confirmed retirement operates on the right content.
      this.linkPageContent(pageOutcomeByUri, source.id, uri)
    }
    return missing
  }

  /** Defense-in-depth read: 'retired' rows never re-enter miss counting. */
  private isRetiredRow(sourceId: string, uri: string): boolean {
    const row = this.options.db
      .prepare(
        `SELECT retirement_state FROM sync_source_pages WHERE source_id = ? AND uri = ?`
      )
      .get(sourceId, uri) as { retirement_state: string } | undefined
    return row?.retirement_state === "retired"
  }

  private getPageRow(sourceId: string, uri: string): SyncSourcePage | null {
    const row = this.options.db
      .prepare(`SELECT * FROM sync_source_pages WHERE source_id = ? AND uri = ?`)
      .get(sourceId, uri) as SyncSourcePageRow | undefined
    return row ? rowToPage(row) : null
  }

  /**
   * Attach the owning ingestion Source/document ids to a ledger row. The
   * submission ran during THIS run — the documents row now names the Source
   * the page's content lives under, which is what retirement operates on.
   * Both the LISTING URL and the final (post-redirect) URL are looked up —
   * a redirecting page must still link to its content (review M-1).
   */
  private linkPageContent(
    pageOutcomeByUri: Map<string, SyncPageOutcome>,
    sourceId: string,
    uri: string
  ): void {
    const outcome = pageOutcomeByUri.get(uri)
    if (!outcome?.documentId) return
    const doc = this.options.db
      .prepare(`SELECT source_id FROM documents WHERE doc_id = ?`)
      .get(outcome.documentId) as { source_id: string | null } | undefined
    if (!doc?.source_id) return
    this.options.db
      .prepare(
        `UPDATE sync_source_pages
         SET ingest_source_id = ?, document_id = ?, updated_at = ?
         WHERE source_id = ? AND uri = ?`
      )
      .run(doc.source_id, outcome.documentId, this.now().toISOString(), sourceId, uri)
  }

  /** Ticket 41 (SYNC-02): the per-page ledger an operator inspects. */
  listPages(tenantId: string, sourceId: string): SyncSourcePage[] {
    this.get(tenantId, sourceId)
    const rows = this.options.db
      .prepare(
        `SELECT * FROM sync_source_pages
         WHERE tenant_id = ? AND source_id = ?
         ORDER BY uri ASC`
      )
      .all(tenantId, sourceId) as SyncSourcePageRow[]
    return rows.map(rowToPage)
  }

  /**
   * Ticket 41 (SYNC-02): confirm retirement of ONE page whose content went
   * missing for TWO consecutive syncs. Anything else is refused — a single
   * temporary miss is never enough, and an unknown page cannot be retired.
   * The retirement itself reuses the normal RetirementService (transition +
   * tombstone + idempotent cleanup tasks), then the ledger row is marked
   * 'retired'.
   */
  confirmPageRetirement(
    tenantId: string,
    sourceId: string,
    uri: string,
    actor: string
  ): RetirementResult & { uri: string } {
    this.get(tenantId, sourceId)
    const page = this.getPageRow(sourceId, uri)
    if (!page) {
      throw new SyncPageNotFoundError()
    }
    if (page.retirementState !== "pending_retirement") {
      throw new SyncPageRetirementConflictError(
        "page is not pending retirement — retirement needs two consecutive missing-page observations"
      )
    }
    if (!page.ingestSourceId) {
      throw new SyncPageRetirementConflictError(
        "page is pending retirement but has no linked content to retire"
      )
    }
    const retirement = this.retirementService().retire(
      page.ingestSourceId,
      tenantId,
      `sync data source ${sourceId}: page missing for ${page.missCount} consecutive syncs`,
      actor
    )
    if (!retirement) {
      // The ingestion Source vanished under us — record the ledger state
      // honestly instead of pretending the content was retired.
      throw new SyncPageRetirementConflictError("the page's content source no longer exists")
    }
    this.options.db
      .prepare(
        `UPDATE sync_source_pages SET retirement_state = 'retired', updated_at = ?
         WHERE source_id = ? AND uri = ?`
      )
      .run(this.now().toISOString(), sourceId, uri)
    return { ...retirement, uri }
  }

  private retirementService(): RetirementServiceImpl {
    const now = this.options.now ?? (() => new Date())
    return new RetirementServiceImpl(
      this.options.db,
      new SqliteSourceLifecycleStore(this.options.db, now),
      new TaskRepo(this.options.db, now),
      now
    )
  }
}

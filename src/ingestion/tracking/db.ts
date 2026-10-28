import Database from "better-sqlite3"
import { createHash } from "node:crypto"
import * as fs from "fs"
import * as path from "path"
import { loadConfig } from "../../config"
import { resolveStoredSourceIdentity, sourceIdentityKey } from "../source_identity"
import { defaultKnowledgeBaseId } from "../../types/knowledge_base"

export type DB = Database.Database

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sources (
    source_id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    source_kind TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    namespace TEXT NOT NULL,
    canonical_source_id TEXT,
    active_doc_id TEXT,
    last_doc_id TEXT,
    last_outcome TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    allowed_groups TEXT NOT NULL DEFAULT '[]',
    lifecycle_state TEXT NOT NULL DEFAULT 'active',
    knowledge_base_id TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    source_id TEXT,
    content_hash TEXT,
    version INTEGER,
    activation_order INTEGER,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    raw_content BLOB,
    file_name TEXT,
    mime_type TEXT,
    parser_override TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    allowed_groups TEXT NOT NULL DEFAULT '[]',
    candidate_state TEXT NOT NULL DEFAULT 'approved',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_reason TEXT,
    knowledge_base_id TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS task_pending_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    fail_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_at TEXT,
    next_attempt_at TEXT,
    enqueued_at TEXT NOT NULL,
    execution_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_status ON task_pending_ops(status)`,
  `CREATE TABLE IF NOT EXISTS task_dead_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL UNIQUE,
    doc_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    fail_count INTEGER NOT NULL,
    error_message TEXT NOT NULL,
    error_stack TEXT,
    failed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS processing_spans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    span_id TEXT NOT NULL UNIQUE,
    parent_span_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    input TEXT,
    output TEXT,
    error_message TEXT,
    error_stack TEXT,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_spans_doc ON processing_spans(doc_id)`,
  `CREATE TABLE IF NOT EXISTS answer_run_events (
    run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, event_id),
    UNIQUE (run_id, sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_answer_run_events_session
    ON answer_run_events(session_id, run_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS page_index_nodes (
    document_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    title TEXT NOT NULL,
    section_path TEXT NOT NULL,
    page_start INTEGER,
    page_end INTEGER,
    summary TEXT NOT NULL,
    parent_id TEXT,
    child_ids TEXT NOT NULL DEFAULT '[]',
    linked_chunk_ids TEXT NOT NULL DEFAULT '[]',
    tenant_id TEXT NOT NULL DEFAULT 'default',
    allowed_groups TEXT NOT NULL DEFAULT '[]',
    knowledge_base_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (document_id, node_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_page_index_doc ON page_index_nodes(document_id)`,
  // Ticket UT-09: durable extraction evidence — the RAW parser output (before
  // any normalization/cleaning), its own hash, the parser configuration
  // fingerprint, per-page coverage and coverage warnings. Reviewers (and the
  // UT-19 reuse path) read the same evidence after a process restart; the
  // cleaned form never overwrites this record.
  `CREATE TABLE IF NOT EXISTS extraction_artifacts (
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    parser_type TEXT NOT NULL,
    parser_config_version TEXT NOT NULL,
    raw_extraction TEXT NOT NULL,
    raw_extraction_sha256 TEXT NOT NULL,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    pages_json TEXT NOT NULL DEFAULT '[]',
    page_count INTEGER,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS clarification_pending (
    session_id TEXT PRIMARY KEY,
    original_message TEXT NOT NULL,
    missing_fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  // Ticket UT-13: the EXPECTED retrieval manifest — every non-parent chunk a
  // document version should contribute to the index, with its stable identity
  // (deterministic uuid v5 from doc+content), content hash and the normalized
  // source blocks it covers. Written at ingestion from the chunk stage; the
  // index-verification ticket (UT-16) compares actual index entries against
  // this persisted list instead of trusting the store's own bookkeeping.
  `CREATE TABLE IF NOT EXISTS expected_chunks (
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    chunk_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL,
    content_sha256 TEXT NOT NULL,
    block_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, version, chunk_id)
  )`,
  `CREATE TABLE IF NOT EXISTS session_bindings (
    session_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'validated' CHECK(kind IN ('validated', 'pending_clarification'))
  )`,
  // Ticket 61 / 01 (spec §2 L1740): One rolling summary record per Tenant-bound
  // session. PRIMARY KEY (session_id, tenant_id) enforces "one record per
  // Tenant-bound session". `summarized_through_turn_id` references
  // conversation_turns.id (no FK — TTL deletes both together per L1747, and
  // tombstone-style retention is not needed for summaries). `schema_version`
  // supports forward-compatible summary format evolution (current = 1).
  `CREATE TABLE IF NOT EXISTS conversation_rolling_summaries (
    session_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    summarized_through_turn_id INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, tenant_id)
  )`,
  // Ticket 09 P1 (spec §8 L1543-1544): Handoff cases — idempotent by run_id
  // (one case per Answer run). State machine: open → claimed → resolved,
  // or open/claimed → cancelled. Cross-tenant isolation via tenant_id filter.
  `CREATE TABLE IF NOT EXISTS handoff_cases (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    user_request TEXT NOT NULL,
    conversation_summary TEXT NOT NULL,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    trace_reference TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'resolved', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_cases_tenant_status
    ON handoff_cases(tenant_id, status)`,
  // Ticket 09 P1 (spec §8 L1546-1548): Feedback — one current record per
  // (tenant_id, subject_id, run_id). Upsert via UNIQUE constraint.
  // reason_code is nullable (null for 'up' ratings; required for 'down').
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
    reason_code TEXT,
    comment TEXT,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    -- Ticket 29 (EVAL-02B): answer/run provenance + review state. message_id is
    -- the browser-owned message id, session_id is derived from the run's trace.
    message_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'reviewed', 'dismissed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id, subject_id, run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_tenant_subject_run
    ON feedback(tenant_id, subject_id, run_id)`,
  // Ticket 11 P1 (spec §11 L1578): Source tombstones — append-only audit
  // records of Source retirements. Tombstones retain Source identity (via
  // source_id reference), retired version IDs (JSON array), reason, actor
  // and timestamps. No FK constraint since tombstones must outlive any
  // physical deletion of the sources row. The source_id is preserved (with
  // lifecycle_state='retired') — physical deletion follows retention policy
  // and does not reuse old IDs (spec L1578).
  `CREATE TABLE IF NOT EXISTS source_tombstones (
    tombstone_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    retired_version_ids TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    retired_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_source_tombstones_source
    ON source_tombstones(source_id, retired_at)`,
  `CREATE INDEX IF NOT EXISTS idx_source_tombstones_tenant
    ON source_tombstones(tenant_id, created_at)`,
  // Ticket 02 (KB-01, spec §8.1 L239-241): knowledge bases. The table is owned
  // by `src/knowledge/knowledge_base_repo.ts` — no other module queries it.
  // The id is deterministic for the per-tenant default (`kb-default-<tenant>`),
  // so a repeated startup inserts nothing; the primary key is what makes that
  // guarantee structural. `status` is the active/archived lifecycle and is the
  // ONLY column a lifecycle transition changes — archiving never deletes the
  // row, the workspace or the database file.
  `CREATE TABLE IF NOT EXISTS knowledge_bases (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    embedding_profile TEXT NOT NULL,
    folder_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_bases_tenant
    ON knowledge_bases(tenant_id, status)`,
  // The folder_id index is created in openDb() rather than here: on an existing
  // database the column only exists after the additive ALTER has run.
  //
  // Knowledge-base folders: ONE level (a folder holds knowledge bases, folders
  // never nest), owned by `src/knowledge/knowledge_base_folder_repo.ts`. A
  // folder is a naming aid for a set, not an ownership boundary — the knowledge
  // base's own tenant_id stays the only isolation axis, and deleting a folder
  // ungroups its members without touching them.
  `CREATE TABLE IF NOT EXISTS knowledge_base_folders (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_base_folders_tenant
    ON knowledge_base_folders(tenant_id, created_at)`,
  // Document folders: the per-knowledge-base directory the document catalog
  // browses by. Owned by `src/knowledge/document_folder_repo.ts`.
  //
  // This table is only the REGISTRY — membership still lives in
  // `documents.metadata.folder` (the name), which is what the catalog filter and
  // the folder facets already read. The registry exists so a folder the user
  // created but has not filled yet is still a folder, and so rename/delete have
  // an id to address. `UNIQUE(knowledge_base_id, name)` is what makes the name a
  // valid membership key inside one knowledge base.
  //
  // Deleting a row here does NOT release members: a document folder holds
  // documents, and removing the directory removes what is in it (through the
  // same per-source retirement the document catalog uses).
  `CREATE TABLE IF NOT EXISTS document_folders (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(knowledge_base_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_document_folders_scope
    ON document_folders(tenant_id, knowledge_base_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS wiki_settings (
    knowledge_base_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_pages (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    page_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'archived')),
    content TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]',
    folder_id TEXT NOT NULL DEFAULT '',
    source_refs TEXT NOT NULL DEFAULT '[]',
    chunk_refs TEXT NOT NULL DEFAULT '[]',
    in_links TEXT NOT NULL DEFAULT '[]',
    out_links TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    last_edit_source TEXT NOT NULL DEFAULT 'pipeline',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(knowledge_base_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope
    ON wiki_pages(tenant_id, knowledge_base_id, status, page_type)`,
  `CREATE TABLE IF NOT EXISTS wiki_revisions (
    page_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    source_refs TEXT NOT NULL,
    chunk_refs TEXT NOT NULL,
    edit_source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(page_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_contributions (
    page_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content TEXT NOT NULL,
    chunk_refs TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY(page_id, document_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_contributions_source
    ON wiki_contributions(source_id, document_id)`,
  `CREATE TABLE IF NOT EXISTS wiki_proposals (
    page_id TEXT PRIMARY KEY,
    base_version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_refs TEXT NOT NULL,
    chunk_refs TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_folders (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_issues (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK(op IN ('ingest', 'retract')),
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    -- LO-16: neutral handoff (NULL = legacy row, '' + 0 = known unsampled).
    trace_id TEXT,
    trace_span_id TEXT,
    trace_sampled INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_jobs_status ON wiki_jobs(status, id)`,
  `CREATE TABLE IF NOT EXISTS cleanup_image_assets (
    document_id TEXT NOT NULL,
    asset_path TEXT NOT NULL,
    PRIMARY KEY(document_id, asset_path)
  )`,
  // Ticket 16 (MODEL-01A): the admin-toggleable enabled state of the three
  // built-in model profiles. The table deliberately holds ONLY the toggle —
  // model ids, base URLs and credentials live in the server environment file
  // (single source of truth), so a profile row can never disagree with what
  // the process calls. Rows are seeded INSERT OR IGNORE at registry
  // construction; a toggle is the only UPDATE this table ever sees.
  `CREATE TABLE IF NOT EXISTS model_profiles (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // Ticket 18 (AST-01A): assistants. Workspace metadata (name/description/
  // groups/status) lives here; everything that influences execution lives in
  // assistant_versions. `current_version` is the pointer an edit moves.
  `CREATE TABLE IF NOT EXISTS assistants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    sidebar_visible INTEGER NOT NULL DEFAULT 1,
    allowed_groups TEXT NOT NULL DEFAULT '[]',
    current_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assistants_tenant ON assistants(tenant_id, status)`,
  // Ticket 18: immutable version rows — an edit INSERTs, nothing ever UPDATEs
  // or DELETEs here, so a conversation can reference an older version forever.
  `CREATE TABLE IF NOT EXISTS assistant_versions (
    assistant_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (assistant_id, version)
  )`,
  // Ticket 30 (FAQ-01A): versioned FAQ entries. Metadata (status + the current
  // version pointer) lives in faq_entries; everything a run executes against
  // lives in immutable faq_entry_versions rows — an edit INSERTs, nothing ever
  // UPDATEs or DELETEs a version, so an old version can be cited forever.
  `CREATE TABLE IF NOT EXISTS faq_entries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    current_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_faq_entries_kb
    ON faq_entries(knowledge_base_id, status)`,
  `CREATE TABLE IF NOT EXISTS faq_entry_versions (
    faq_entry_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    question TEXT NOT NULL,
    normalized_question TEXT NOT NULL,
    variants TEXT NOT NULL DEFAULT '[]',
    answer TEXT NOT NULL,
    source TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (faq_entry_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_faq_entry_versions_normalized
    ON faq_entry_versions(normalized_question)`,
  // Ticket 20 (CONV-01A): server-owned conversation directories. The id is
  // the thread/session id the browser already generates; ownership is the
  // (tenant_id, subject_id) pair, so the directory is user-isolated. `title`
  // is derived from the first user message; `imported` marks directories that
  // arrived through the one-time browser import.
  `CREATE TABLE IF NOT EXISTS conversation_directories (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    title TEXT NOT NULL,
    imported INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Ticket 21 (CONV-01B): locked by the first message. NULL until then.
    assistant_id TEXT,
    assistant_version INTEGER,
    knowledge_base_ids TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_directories_owner
    ON conversation_directories(tenant_id, subject_id, updated_at)`,
  // Ticket 20 (CONV-01A): history turns that are NOT validated memory. The
  // memory layer (conversation_turns, kind='validated') only ever records
  // pairs whose answer passed the Critic; runs that ended otherwise —
  // refusal, cancellation, failure — are recorded HERE with their terminal
  // status, so history stays complete while validated memory stays clean.
  `CREATE TABLE IF NOT EXISTS conversation_history_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    run_id TEXT NOT NULL,
    terminal_status TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_history_turns_session
    ON conversation_history_turns(session_id, id)`,
  // Ticket 22 (ATT-01): temporary SESSION-SCOPED attachments. The triple
  // (session_id, tenant_id, subject_id) is the isolation key — another
  // session, even of the same user, is the same 404 as an unknown one.
  // `content` keeps the decoded text so an explicit promotion can re-submit
  // it through the normal ingestion rules without re-reading the browser.
  `CREATE TABLE IF NOT EXISTS session_attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT,
    bytes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('parsing','ready','failed','promoted','retired')),
    content TEXT NOT NULL,
    raw_content BLOB,
    error TEXT,
    promoted_document_id TEXT,
    promoted_knowledge_base_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_attachments_owner
    ON session_attachments(session_id, tenant_id, subject_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS session_attachment_chunks (
    attachment_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (attachment_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_attachment_chunks_session
    ON session_attachment_chunks(session_id, tenant_id, attachment_id, position)`,
  // Ticket 32 (MEM-01A): user-owned durable preferences. One owner
  // (tenant, subject), optionally pinned to one assistant; assistant_id
  // NULL means the record applies across the user's assistants. The owner
  // columns are part of every read and write — another user's row is the
  // same missing row as an unknown id.
  `CREATE TABLE IF NOT EXISTS long_term_memories (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    assistant_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_long_term_memories_owner
    ON long_term_memories(tenant_id, subject_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_long_term_memories_recall
    ON long_term_memories(tenant_id, subject_id, assistant_id)`,
  // Ticket 33 (MEM-01B): extraction suggestions. Automatic extraction only
  // ever writes PENDING rows here — a memory is published exclusively by the
  // owner accepting a suggestion. Same owner triple as the memory table.
  `CREATE TABLE IF NOT EXISTS memory_suggestions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    assistant_id TEXT,
    source_run_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','dismissed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_suggestions_review
    ON memory_suggestions(tenant_id, subject_id, status, created_at)`,
  // Ticket 39 (SYNC-01A): URL/sitemap data sources owned by the sync module.
  // One row = one resource (a URL or a sitemap) synced into exactly ONE
  // knowledge base. `interval` records the operator's cadence choice
  // (manual = never scheduled; scheduling itself is ticket 40's runs table).
  // `state` is the operator lifecycle (active rows sync; paused rows do not).
  `CREATE TABLE IF NOT EXISTS sync_data_sources (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('url','sitemap')),
    uri TEXT NOT NULL,
    interval TEXT NOT NULL DEFAULT 'manual' CHECK(interval IN ('manual','1h','6h','24h')),
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused')),
    title TEXT NOT NULL DEFAULT '',
    last_sync_at TEXT,
    last_sync_status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sync_data_sources_kb
    ON sync_data_sources(tenant_id, knowledge_base_id, state)`,
  // Ticket 40 (SYNC-01B): durable sync runs. Exactly ONE pending/running run
  // may exist per data source — enforced by the partial unique index, which
  // is what makes concurrent triggers claim-safe without a separate lock
  // service. A run row IS the durable work item: a process restart finds
  // pending rows and resumes them; failed rows are kept as records (they
  // never auto-retry and never touched the active version).
  `CREATE TABLE IF NOT EXISTS sync_runs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('manual','schedule')),
    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
    summary TEXT,
    error TEXT,
    lease_expires_at TEXT,
    -- LO-15: neutral handoff captured at trigger time. Empty strings mean
    -- "known unsampled" (never re-sampled); NULL means "legacy, no source".
    trace_id TEXT,
    trace_span_id TEXT,
    trace_sampled INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_single_active
    ON sync_runs(source_id) WHERE status IN ('pending','running')`,
  `CREATE INDEX IF NOT EXISTS idx_sync_runs_claim
    ON sync_runs(status, created_at)`,
  // Ticket 41 (SYNC-02): per-page outcomes of one sync run — the durable
  // run-log. A run's summary is the bounded headline; these rows are the
  // detail view: per-page status plus a machine-readable failure kind
  // (timeout / rate_limit / invalid_url / policy_denied / http_error /
  // network / empty) so operators can tell WHY a page failed. A page that
  // disappeared from a successful sitemap read is a 'missing' row — the
  // observation an explicit retirement confirmation is later based on.
  `CREATE TABLE IF NOT EXISTS sync_run_pages (
    run_id TEXT NOT NULL,
    uri TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('submitted','unchanged','failed','missing')),
    failure_kind TEXT,
    detail TEXT,
    document_id TEXT,
    version INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sync_run_pages ON sync_run_pages(run_id)`,
  // Ticket 41 (SYNC-02): per-page presence of a sitemap data source — the
  // missing-page ledger behind safe retirement. A page that was previously
  // synced but absent from the current successful sitemap read accumulates
  // miss_count; TWO consecutive misses mark it 'pending_retirement'. The
  // content stays searchable until an administrator EXPLICITLY confirms
  // retirement (retirement_state 'retired' is terminal here, mirroring the
  // source lifecycle's terminal 'retired').
  `CREATE TABLE IF NOT EXISTS sync_source_pages (
    source_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    uri TEXT NOT NULL,
    ingest_source_id TEXT,
    document_id TEXT,
    last_seen_at TEXT,
    miss_count INTEGER NOT NULL DEFAULT 0,
    retirement_state TEXT NOT NULL DEFAULT 'none'
      CHECK(retirement_state IN ('none','pending_retirement','retired')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_id, uri)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sync_source_pages_state
    ON sync_source_pages(source_id, retirement_state)`,
].join(";\n")

let _db: DB | null = null

export function openDb(dbPath?: string): DB {
  if (_db && !dbPath) return _db
  const resolved = dbPath ?? loadConfig().sqlitePath
  const dir = path.dirname(resolved)
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const db = new Database(resolved)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA)
  const sourceColumns = db.pragma("table_info(sources)") as Array<{ name: string }>
  if (!sourceColumns.some(({ name }) => name === "canonical_source_id")) {
    db.exec("ALTER TABLE sources ADD COLUMN canonical_source_id TEXT")
  }
  // Ticket 05 P2: additive migration — default to single-tenant identity for existing rows.
  if (!sourceColumns.some(({ name }) => name === "tenant_id")) {
    db.exec("ALTER TABLE sources ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'")
  }
  if (!sourceColumns.some(({ name }) => name === "allowed_groups")) {
    db.exec("ALTER TABLE sources ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]'")
  }
  const documentColumns = db.pragma("table_info(documents)") as Array<{ name: string }>
  // Ticket 06 P1: additive migration — default to single-tenant identity for existing rows.
  if (!documentColumns.some(({ name }) => name === "tenant_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'")
  }
  if (!documentColumns.some(({ name }) => name === "allowed_groups")) {
    db.exec("ALTER TABLE documents ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]'")
  }
  if (!documentColumns.some(({ name }) => name === "source_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN source_id TEXT")
  }
  // Ticket 40 (SYNC-01B): additive migration — the stored next-run state of a
  // scheduled sync data source (databases created before ticket 40 lack it).
  const syncSourceColumns = db.pragma("table_info(sync_data_sources)") as Array<{ name: string }>
  if (
    syncSourceColumns.length > 0 &&
    !syncSourceColumns.some(({ name }) => name === "next_run_at")
  ) {
    db.exec("ALTER TABLE sync_data_sources ADD COLUMN next_run_at TEXT")
  }
  // LO-15: additive migration — existing databases predate the handoff
  // columns. Legacy rows stay NULL and run under the root policy.
  const syncRunColumns = db.pragma("table_info(sync_runs)") as Array<{ name: string }>
  if (syncRunColumns.length > 0) {
    if (!syncRunColumns.some(({ name }) => name === "trace_id")) {
      db.exec("ALTER TABLE sync_runs ADD COLUMN trace_id TEXT")
    }
    if (!syncRunColumns.some(({ name }) => name === "trace_span_id")) {
      db.exec("ALTER TABLE sync_runs ADD COLUMN trace_span_id TEXT")
    }
    if (!syncRunColumns.some(({ name }) => name === "trace_sampled")) {
      db.exec("ALTER TABLE sync_runs ADD COLUMN trace_sampled INTEGER")
    }
  }
  // LO-16: additive migration for wiki jobs created before the handoff.
  const wikiJobColumns = db.pragma("table_info(wiki_jobs)") as Array<{ name: string }>
  if (wikiJobColumns.length > 0) {
    if (!wikiJobColumns.some(({ name }) => name === "trace_id")) {
      db.exec("ALTER TABLE wiki_jobs ADD COLUMN trace_id TEXT")
    }
    if (!wikiJobColumns.some(({ name }) => name === "trace_span_id")) {
      db.exec("ALTER TABLE wiki_jobs ADD COLUMN trace_span_id TEXT")
    }
    if (!wikiJobColumns.some(({ name }) => name === "trace_sampled")) {
      db.exec("ALTER TABLE wiki_jobs ADD COLUMN trace_sampled INTEGER")
    }
  }
  // Ticket 21: the attachment channel retains the UPLOADED bytes alongside the
  // decoded text, so a promotion re-submits the original file — not a
  // re-encoded decode of it (legacy rows carry NULL and keep the decode).
  const attachmentColumns = db.pragma("table_info(session_attachments)") as Array<{ name: string }>
  if (attachmentColumns.length > 0 && !attachmentColumns.some(({ name }) => name === "raw_content")) {
    db.exec("ALTER TABLE session_attachments ADD COLUMN raw_content BLOB")
  }
  if (!documentColumns.some(({ name }) => name === "content_hash")) {
    db.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "version")) {
    db.exec("ALTER TABLE documents ADD COLUMN version INTEGER")
  }
  if (!documentColumns.some(({ name }) => name === "activation_order")) {
    db.exec("ALTER TABLE documents ADD COLUMN activation_order INTEGER")
  }
  if (!documentColumns.some(({ name }) => name === "raw_content")) {
    db.exec("ALTER TABLE documents ADD COLUMN raw_content BLOB")
  }
  if (!documentColumns.some(({ name }) => name === "file_name")) {
    db.exec("ALTER TABLE documents ADD COLUMN file_name TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "mime_type")) {
    db.exec("ALTER TABLE documents ADD COLUMN mime_type TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "parser_override")) {
    db.exec("ALTER TABLE documents ADD COLUMN parser_override TEXT")
  }
  // Ticket 11 P1 (spec §11 L1571-1578): additive migration — Source governance
  // lifecycle columns. Defaults preserve backward compatibility:
  //   - sources.lifecycle_state = 'active' (existing Sources remain queryable)
  //   - documents.candidate_state = 'approved' (existing completed candidates
  //     remain active without requiring review)
  //   - reviewed_by / reviewed_at / review_reason are nullable — only set
  //     when a human review occurs (ACTIVATION_MODE=review, spec L1574)
  if (!sourceColumns.some(({ name }) => name === "lifecycle_state")) {
    db.exec("ALTER TABLE sources ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'")
  }
  // Ticket 03 (KB-02A): additive migration — knowledge-base ownership. The
  // column starts empty and is backfilled below to the row's tenant default.
  if (!sourceColumns.some(({ name }) => name === "knowledge_base_id")) {
    db.exec("ALTER TABLE sources ADD COLUMN knowledge_base_id TEXT NOT NULL DEFAULT ''")
  }
  if (!documentColumns.some(({ name }) => name === "candidate_state")) {
    db.exec("ALTER TABLE documents ADD COLUMN candidate_state TEXT NOT NULL DEFAULT 'approved'")
  }
  if (!documentColumns.some(({ name }) => name === "reviewed_by")) {
    db.exec("ALTER TABLE documents ADD COLUMN reviewed_by TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "reviewed_at")) {
    db.exec("ALTER TABLE documents ADD COLUMN reviewed_at TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "review_reason")) {
    db.exec("ALTER TABLE documents ADD COLUMN review_reason TEXT")
  }
  // Ticket UT-04: additive migration — the joint activation gate. Evidence is
  // written only by the integrity producers introduced in UT-15/UT-16; until
  // then the column stays NULL and every new candidate is denied activation
  // with a recorded reason. Existing active rows are never re-evaluated.
  if (!documentColumns.some(({ name }) => name === "candidate_evidence")) {
    db.exec("ALTER TABLE documents ADD COLUMN candidate_evidence TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "activation_block_reason")) {
    db.exec("ALTER TABLE documents ADD COLUMN activation_block_reason TEXT")
  }
  // Ticket 03 (KB-02A): additive migration — knowledge-base ownership.
  if (!documentColumns.some(({ name }) => name === "knowledge_base_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN knowledge_base_id TEXT NOT NULL DEFAULT ''")
  }
  // Ticket 06 P3: additive migration — page_index_nodes access metadata.
  const pageIndexColumns = db.pragma("table_info(page_index_nodes)") as Array<{ name: string }>
  if (!pageIndexColumns.some(({ name }) => name === "tenant_id")) {
    db.exec("ALTER TABLE page_index_nodes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'")
  }
  if (!pageIndexColumns.some(({ name }) => name === "allowed_groups")) {
    db.exec("ALTER TABLE page_index_nodes ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]'")
  }
  // Ticket 03 (KB-02A): additive migration — knowledge-base ownership.
  if (!pageIndexColumns.some(({ name }) => name === "knowledge_base_id")) {
    db.exec("ALTER TABLE page_index_nodes ADD COLUMN knowledge_base_id TEXT NOT NULL DEFAULT ''")
  }
  // Ticket 08 P5: additive migration — kind discriminator absorbs pending
  // clarification into the same Conversation state (spec §7 L1538). Existing
  // P1 rows default to 'validated' so loadRecentTurns behavior is unchanged.
  const conversationColumns = db.pragma("table_info(conversation_turns)") as Array<{ name: string }>
  if (!conversationColumns.some(({ name }) => name === "kind")) {
    db.exec("ALTER TABLE conversation_turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'validated'")
  }
  const legacyDocuments = db.prepare(
    `SELECT doc_id, source, content, status, created_at, updated_at
     FROM documents
     WHERE source_id IS NULL OR content_hash IS NULL OR version IS NULL
     ORDER BY created_at ASC, doc_id ASC`
  ).all() as Array<{
    doc_id: string
    source: string
    content: string
    status: string
    created_at: string
    updated_at: string
  }>
  const upgradeLegacyDocuments = db.transaction(() => {
    for (const document of legacyDocuments) {
      const identity = resolveStoredSourceIdentity(document.source, document.doc_id)
      const sourceKey = sourceIdentityKey(identity)
      const sourceId = `legacy:${sourceKey}`
      db.prepare(
        `INSERT INTO sources (
          source_id, source_key, source_kind, source_uri, namespace,
          active_doc_id, last_doc_id, last_outcome, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(source_key) DO NOTHING`
      ).run(
        sourceId,
        sourceKey,
        identity.kind,
        identity.uri,
        identity.namespace,
        document.created_at,
        document.updated_at
      )
      const storedSource = db.prepare(
        `SELECT source_id FROM sources WHERE source_key = ?`
      ).get(sourceKey) as { source_id: string }
      const nextVersion = db.prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM documents WHERE source_id = ?`
      ).get(storedSource.source_id) as { version: number }
      db.prepare(
        `UPDATE documents
         SET source_id = ?, content_hash = ?, version = ?, activation_order = ?
         WHERE doc_id = ?`
      ).run(
        storedSource.source_id,
        createHash("sha256").update(document.content, "utf8").digest("hex"),
        nextVersion.version,
        nextVersion.version,
        document.doc_id
      )
      db.prepare(
        `UPDATE sources
         SET active_doc_id = CASE
               WHEN ? = 'completed' AND (
                 active_doc_id IS NULL OR
                 (SELECT created_at FROM documents WHERE doc_id = active_doc_id) <= ?
               ) THEN ?
               ELSE active_doc_id
             END,
             last_doc_id = CASE
               WHEN last_doc_id IS NULL OR
                 (SELECT created_at FROM documents WHERE doc_id = last_doc_id) <= ?
               THEN ?
               ELSE last_doc_id
             END,
             last_outcome = CASE
               WHEN last_doc_id IS NULL OR
                 (SELECT created_at FROM documents WHERE doc_id = last_doc_id) <= ?
               THEN ?
               ELSE last_outcome
             END,
             updated_at = CASE WHEN updated_at <= ? THEN ? ELSE updated_at END
         WHERE source_id = ?`
      ).run(
        document.status,
        document.created_at,
        document.doc_id,
        document.created_at,
        document.doc_id,
        document.created_at,
        document.status,
        document.updated_at,
        document.updated_at,
        storedSource.source_id
      )
    }
  })
  upgradeLegacyDocuments()
  db.exec(
    "UPDATE documents SET activation_order = version WHERE activation_order IS NULL"
  )
  // Ticket 03 (KB-02A, criterion 4): no artifact may exist without ownership.
  // Runs AFTER upgradeLegacyDocuments() so the rows that migration just created
  // are owned too. A legacy row belongs to its tenant's deterministic default
  // knowledge base; the id prefix comes from defaultKnowledgeBaseId so the
  // format has exactly one definition.
  const defaultKnowledgeBaseIdPrefix = defaultKnowledgeBaseId("")
  for (const table of ["sources", "documents", "page_index_nodes"]) {
    db.exec(
      `UPDATE ${table}
       SET knowledge_base_id = '${defaultKnowledgeBaseIdPrefix}' || tenant_id
       WHERE knowledge_base_id = ''`
    )
  }
  const taskColumns = db.pragma("table_info(task_pending_ops)") as Array<{ name: string }>
  if (!taskColumns.some(({ name }) => name === "next_attempt_at")) {
    db.exec("ALTER TABLE task_pending_ops ADD COLUMN next_attempt_at TEXT")
  }
  // Ticket 25: durable execution identity — the claim fence that survives
  // restarts. Existing rows have no execution id until their next claim.
  if (!taskColumns.some(({ name }) => name === "execution_id")) {
    db.exec("ALTER TABLE task_pending_ops ADD COLUMN execution_id TEXT")
  }
  const spanColumns = db.pragma("table_info(processing_spans)") as Array<{ name: string }>
  if (!spanColumns.some(({ name }) => name === "error_stack")) {
    db.exec("ALTER TABLE processing_spans ADD COLUMN error_stack TEXT")
  }
  // Ticket 21 (CONV-01B): the first message locks assistant version + knowledge
  // subset onto the directory. Existing rows stay unlocked (NULL) until a run.
  const directoryColumns = db.pragma("table_info(conversation_directories)") as Array<{ name: string }>
  if (directoryColumns.length > 0 && !directoryColumns.some(({ name }) => name === "assistant_id")) {
    db.exec("ALTER TABLE conversation_directories ADD COLUMN assistant_id TEXT")
    db.exec("ALTER TABLE conversation_directories ADD COLUMN assistant_version INTEGER")
    db.exec("ALTER TABLE conversation_directories ADD COLUMN knowledge_base_ids TEXT")
  }
  // Ticket 29 (EVAL-02B): existing databases get the answer/run provenance and
  // review-state columns. The index is created HERE (not in SCHEMA) because an
  // old table only has the column after this ALTER ran.
  const feedbackColumns = db.pragma("table_info(feedback)") as Array<{ name: string }>
  if (feedbackColumns.length > 0 && !feedbackColumns.some(({ name }) => name === "message_id")) {
    db.exec("ALTER TABLE feedback ADD COLUMN message_id TEXT NOT NULL DEFAULT ''")
    db.exec("ALTER TABLE feedback ADD COLUMN session_id TEXT NOT NULL DEFAULT ''")
    db.exec("ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'open'")
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_feedback_tenant_status ON feedback(tenant_id, status, updated_at)"
  )
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_claimable ON task_pending_ops(status, next_attempt_at, id)"
  )
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_version ON documents(source_id, version)"
  )
  // Knowledge-base folders: additive migration — the grouping column. Existing
  // rows are deliberately NOT backfilled into a synthetic folder: an ungrouped
  // knowledge base is the honest reading of the old data, and NULL is exactly
  // what the read path already treats as 未分类.
  const knowledgeBaseColumns = db.pragma("table_info(knowledge_bases)") as Array<{ name: string }>
  if (!knowledgeBaseColumns.some(({ name }) => name === "folder_id")) {
    db.exec("ALTER TABLE knowledge_bases ADD COLUMN folder_id TEXT")
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_knowledge_bases_folder ON knowledge_bases(tenant_id, folder_id)"
  )
  // Sidebar curation: admins uncheck assistants to hide them from the
  // sidebar selector. Default 1 keeps every existing row visible (the
  // pre-column behavior). The tenant default assistant is always visible —
  // that refusal lives in AssistantService.setSidebarVisible, not here.
  const assistantColumns = db.pragma("table_info(assistants)") as Array<{ name: string }>
  if (!assistantColumns.some(({ name }) => name === "sidebar_visible")) {
    db.exec("ALTER TABLE assistants ADD COLUMN sidebar_visible INTEGER NOT NULL DEFAULT 1")
  }
  if (!dbPath) _db = db
  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

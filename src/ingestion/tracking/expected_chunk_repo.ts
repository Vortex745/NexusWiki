// UT-13: expected retrieval manifest repository.
//
// The chunk stage produces a deterministic list of index-bound chunks (stable
// uuid v5 identity derived from doc id + content). This repository persists
// that list — chunk id, kind, position, content sha256 and the normalized
// source blocks each chunk covers — so the index-verification path (UT-16)
// can compare ACTUAL index entries against an independent persisted expectation
// instead of trusting the store's own bookkeeping, and so the same input and
// configuration re-run reproduces identical identities.
import { createHash } from "node:crypto"
import type { DB } from "./db"

export interface ExpectedChunkEntry {
  chunkId: string
  kind: string
  position: number
  contentSha256: string
  blockIds: string[]
}

interface ExpectedChunkRow {
  chunk_id: string
  kind: string
  position: number
  content_sha256: string
  block_ids_json: string
}

export class ExpectedChunkRepository {
  constructor(private db: DB) {}

  /**
   * Replace the manifest for a document version in one transaction. Chunks
   * with kind "parent" never enter the index and are rejected here so the
   * manifest stays exactly the index expectation.
   */
  replaceAll(docId: string, version: number, entries: ExpectedChunkEntry[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO expected_chunks
        (doc_id, version, chunk_id, kind, position, content_sha256, block_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const remove = this.db.prepare(
      "DELETE FROM expected_chunks WHERE doc_id = ? AND version = ?"
    )
    const write = this.db.transaction(() => {
      remove.run(docId, version)
      for (const entry of entries) {
        if (entry.kind === "parent") {
          throw new Error(
            `expected-chunk manifest must not contain parent chunks (${entry.chunkId})`
          )
        }
        insert.run(
          docId,
          version,
          entry.chunkId,
          entry.kind,
          entry.position,
          entry.contentSha256,
          JSON.stringify(entry.blockIds),
          new Date().toISOString()
        )
      }
    })
    write()
  }

  list(docId: string, version?: number): ExpectedChunkEntry[] {
    const row = version === undefined
      ? this.db.prepare(
          "SELECT version FROM expected_chunks WHERE doc_id = ? ORDER BY version DESC LIMIT 1"
        ).get(docId) as { version: number } | undefined
      : undefined
    const resolvedVersion = version ?? row?.version
    if (resolvedVersion === undefined) return []
    const rows = this.db.prepare(
      `SELECT chunk_id, kind, position, content_sha256, block_ids_json
       FROM expected_chunks WHERE doc_id = ? AND version = ? ORDER BY position ASC`
    ).all(docId, resolvedVersion) as ExpectedChunkRow[]
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      kind: r.kind,
      position: r.position,
      contentSha256: r.content_sha256,
      blockIds: JSON.parse(r.block_ids_json) as string[],
    }))
  }

  /** Stable content hash used for every manifest entry. */
  static contentSha256(content: string): string {
    return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex")
  }
}

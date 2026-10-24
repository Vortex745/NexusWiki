import { createHash } from "node:crypto"
import type { Client, estypes } from "@elastic/elasticsearch"
import { resolveChunkIndexName } from "../../config"
import { CHUNK_METADATA_FLOAT_LEAF_PATHS } from "./store"

const FLOAT_PATHS = CHUNK_METADATA_FLOAT_LEAF_PATHS.map(path => ["metadata", ...path].join("."))

export interface ChunkIndexMigrationOptions {
  node: string
  source: string
  target: string
  embeddingDimensions: number
  apply?: boolean
}

export interface ChunkIndexMigrationReport {
  phase: "preview" | "verified"
  source: string
  target: string
  sourceCount: number
  targetCount?: number
  embeddingDimensions: number
  sourceBytes: number
  originalWriteBlock: boolean
  manifestSha256?: string
  fractionalValues?: number
  /** Successful apply keeps both indexes locked until the operator cuts over. */
  sourceLocked: boolean
  targetLocked: boolean
}

/** Only module-authored diagnostics may cross the CLI report boundary. */
export class ChunkIndexMigrationError extends Error {
  constructor(message: string) { super(message); this.name = "ChunkIndexMigrationError" }
}

/** Preserve causes for in-process diagnosis without exporting their messages. */
export class ChunkIndexMigrationRestoreError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "Migration failed and source write lock could not be restored; verify cluster write-lock state before resuming.")
    this.name = "ChunkIndexMigrationRestoreError"
  }
}

export function safeMigrationDiagnostic(error: unknown): string {
  if (error instanceof ChunkIndexMigrationError || error instanceof ChunkIndexMigrationRestoreError) return error.message
  return "Elasticsearch migration failed; inspect cluster status. Original source is preserved; verify source write-lock state before resuming."
}

function validateIndex(value: string): void {
  if (!value || value !== value.trim()) {
    throw new ChunkIndexMigrationError("Migration requires an explicit legal physical index name")
  }
  try { resolveChunkIndexName(value) }
  catch { throw new ChunkIndexMigrationError("Migration requires an explicit legal physical index name") }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function valuesAt(value: unknown, path: string[]): number[] {
  if (Array.isArray(value)) return value.flatMap(item => valuesAt(item, path))
  if (!path.length) {
    if (typeof value === "number" && Number.isFinite(value)) return [value]
    if (value === undefined || value === null) return []
    throw new ChunkIndexMigrationError("Fractional metadata contains a non-numeric value")
  }
  return value && typeof value === "object"
    ? valuesAt((value as Record<string, unknown>)[path[0]], path.slice(1)) : []
}

function correctedMapping(source: estypes.MappingTypeMapping): estypes.MappingTypeMapping {
  const mapping = structuredClone(source)
  mapping.properties ??= {}
  for (const field of FLOAT_PATHS) {
    let properties = mapping.properties
    const parts = field.split(".")
    for (const part of parts.slice(0, -1)) {
      const existing = properties[part] as estypes.MappingObjectProperty | undefined
      if (existing?.type && existing.type !== "object" && existing.type !== "nested") {
        throw new ChunkIndexMigrationError(`Cannot repair incompatible metadata container ${part}`)
      }
      const node: estypes.MappingObjectProperty = existing ?? { type: "object", properties: {} }
      node.properties ??= {}
      properties[part] = node
      properties = node.properties
    }
    properties[parts.at(-1)!] = { type: "float" }
  }
  return mapping
}

interface ManifestRow { hash: string; routing?: string }
async function manifest(client: Client, index: string, dimensions: number, verifyFloats: boolean) {
  const rows = new Map<string, ManifestRow>()
  let fractionalValues = 0
  const pit = await client.openPointInTime({ index, keep_alive: "1m" })
  let pitId = pit.id
  let after: estypes.SortResults | undefined
  try {
    for (;;) {
      const response = await client.search<Record<string, unknown>>({
        pit: { id: pitId, keep_alive: "1m" }, size: 200,
        sort: ["_shard_doc"], search_after: after,
        // The source vector is required below; an excluded vector stops copying.
        _source: true,
        stored_fields: ["_routing"],
        ...(verifyFloats ? { docvalue_fields: [...FLOAT_PATHS] } : {}),
      })
      pitId = response.pit_id ?? pitId
      const hits = response.hits.hits
      if (!hits.length) break
      for (const hit of hits) {
        const source = hit._source
        if (!source || !hit._id) throw new ChunkIndexMigrationError(`Missing stored source or ID in ${index}`)
        const embedding = source.embedding
        const unembeddedParent = source.kind === "parent" && embedding === undefined
        if (!unembeddedParent && (!Array.isArray(embedding) || embedding.length !== dimensions
          || embedding.some(n => typeof n !== "number" || !Number.isFinite(n)))) {
          throw new ChunkIndexMigrationError(`Incomplete source vector in ${index}`)
        }
        if (rows.has(hit._id)) throw new ChunkIndexMigrationError(`Duplicate ID during scan of ${index}`)
        rows.set(hit._id, { hash: digest(source), routing: hit._routing })
        for (const path of FLOAT_PATHS) {
          const values = valuesAt(source, path.split("."))
          fractionalValues += values.filter(n => !Number.isInteger(n)).length
          if (verifyFloats) {
            const expected = [...new Set(values.map(Math.fround))].sort((a, b) => a - b)
            const actual = [...new Set((hit.fields?.[path] ?? []) as number[])].sort((a, b) => a - b)
            if (canonical(actual) !== canonical(expected)) {
              throw new ChunkIndexMigrationError(`Float docvalues differ at ${index}/${path}`)
            }
          }
        }
      }
      after = hits.at(-1)!.sort
      if (!after) throw new ChunkIndexMigrationError(`Missing pagination cursor in ${index}`)
    }
  } finally {
    await client.closePointInTime({ id: pitId })
  }
  return { rows, fractionalValues }
}

/** Copy from stored source, prove full fidelity, and leave both sides protected. */
export async function migrateChunkIndex(
  client: Client, options: ChunkIndexMigrationOptions
): Promise<ChunkIndexMigrationReport> {
  const { source, target, embeddingDimensions } = options
  let endpoint: URL
  try { endpoint = new URL(options.node) }
  catch { throw new ChunkIndexMigrationError("Migration requires a valid loopback development cluster URL") }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    throw new ChunkIndexMigrationError("This maintenance tool only operates on a loopback development cluster")
  }
  validateIndex(source); validateIndex(target)
  if (source === target) throw new ChunkIndexMigrationError("Source and target must differ")
  if (!Number.isSafeInteger(embeddingDimensions) || embeddingDimensions <= 0) throw new ChunkIndexMigrationError("Invalid embedding dimensions")
  if (!(await client.indices.exists({ index: source }))) throw new ChunkIndexMigrationError("Source index does not exist")
  if (await client.indices.exists({ index: target })) throw new ChunkIndexMigrationError("Target already exists; refusing to overwrite")
  const mapping = (await client.indices.getMapping({ index: source }))[source]?.mappings
  if (!mapping || mapping._source?.enabled === false || mapping._source?.mode === "synthetic") {
    throw new ChunkIndexMigrationError("Migration requires STORED original _source")
  }
  const embedding = mapping.properties?.embedding as estypes.MappingDenseVectorProperty | undefined
  if (embedding?.dims !== embeddingDimensions) throw new ChunkIndexMigrationError("Configured and source embedding dimensions differ")
  const originalSettings = (await client.indices.getSettings({ index: source }))[source].settings?.index
  if (!originalSettings) throw new ChunkIndexMigrationError("Source settings unavailable")
  const settings = structuredClone(originalSettings) as Record<string, unknown>
  const sourceMode = (settings.mapping as { source?: { mode?: string } } | undefined)?.source?.mode
  if (sourceMode && sourceMode !== "stored") throw new ChunkIndexMigrationError("Migration requires STORED original _source")
  const originalWriteBlock = String((settings.blocks as { write?: unknown } | undefined)?.write ?? "false") === "true"
  for (const key of ["uuid", "creation_date", "version", "provided_name", "resize", "history"]) delete settings[key]
  // Read/write locks are operational state, never copied into the destination.
  delete settings.blocks
  const stats = await client.indices.stats({ index: source, metric: "store" })
  const sourceBytes = stats._all.total?.store?.size_in_bytes
  if (typeof sourceBytes !== "number") throw new ChunkIndexMigrationError("Source size unavailable")
  const disks = await client.cat.allocation({ format: "json", bytes: "b" })
  const available = disks.map(row => Number(row["disk.avail"])).filter(n => Number.isFinite(n) && n > 0)
  if (!available.length || Math.min(...available) < sourceBytes * 2) throw new ChunkIndexMigrationError("Insufficient verified disk space")
  const corrected = correctedMapping(mapping)
  let locked = false
  try {
    if (options.apply) {
      // Even a lost response may have installed the lock on the cluster.
      locked = true
      const barrier = await client.indices.addBlock({ index: source, block: "write" })
      if (!barrier.acknowledged || !barrier.shards_acknowledged) {
        throw new ChunkIndexMigrationError("Source write barrier was not acknowledged by every shard")
      }
      await client.indices.refresh({ index: source })
    }
    const before = await manifest(client, source, embeddingDimensions, false)
    const report: ChunkIndexMigrationReport = {
      phase: "preview", source, target, sourceCount: before.rows.size,
      embeddingDimensions, sourceBytes, originalWriteBlock, sourceLocked: locked || originalWriteBlock, targetLocked: false,
    }
    if (!options.apply) return report
    await client.indices.create({ index: target, settings: settings as estypes.IndicesIndexSettings, mappings: corrected })
    const result = await client.reindex({
      source: { index: source }, dest: { index: target, op_type: "create" },
      wait_for_completion: true, refresh: true,
    }, { requestTimeout: 120_000 })
    if (result.timed_out || result.failures?.length || result.total !== before.rows.size || result.created !== before.rows.size) {
      throw new ChunkIndexMigrationError("Reindex failed or did not copy every frozen document")
    }
    const targetBarrier = await client.indices.addBlock({ index: target, block: "write" })
    if (!targetBarrier.acknowledged || !targetBarrier.shards_acknowledged) {
      throw new ChunkIndexMigrationError("Target write barrier was not acknowledged by every shard")
    }
    const after = await manifest(client, target, embeddingDimensions, true)
    if (before.rows.size !== after.rows.size) throw new ChunkIndexMigrationError("Target ID count differs")
    for (const [id, row] of before.rows) {
      const copied = after.rows.get(id)
      if (!copied || row.hash !== copied.hash || row.routing !== copied.routing) {
        throw new ChunkIndexMigrationError("Source, vector or routing mismatch for a frozen document")
      }
    }
    return {
      ...report, phase: "verified", targetCount: after.rows.size, targetLocked: true,
      fractionalValues: after.fractionalValues,
      manifestSha256: digest([...before.rows].sort(([a], [b]) => a.localeCompare(b))),
    }
  } catch (error) {
    if (locked) {
      try {
        await client.indices.putSettings({ index: source, settings: { "index.blocks.write": originalWriteBlock } })
      } catch (restoreError) {
        throw new ChunkIndexMigrationRestoreError([error, restoreError])
      }
    }
    throw error
  }
}

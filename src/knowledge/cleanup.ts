import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import { createElasticsearchClient } from "../clients"
import { loadConfig, resolveChunkIndexName } from "../config"
import { createDriver } from "../graph"
import type { DB } from "../ingestion/tracking/db"
import type { Document } from "../types"

const ASSET_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/

export type CleanupOperation = "cleanup_es" | "cleanup_neo4j" |
  "cleanup_pageindex" | "cleanup_images"

export function isCleanupOperation(value: string): value is CleanupOperation {
  return ["cleanup_es", "cleanup_neo4j", "cleanup_pageindex", "cleanup_images"]
    .includes(value)
}

function imagePaths(source: Record<string, unknown>): string[] {
  const metadata = source.metadata as Record<string, unknown> | undefined
  const paths: string[] = []
  const add = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    const path = (value as Record<string, unknown>).assetPath
    if (typeof path === "string" && ASSET_NAME.test(path)) paths.push(path)
  }
  add(metadata?.image)
  if (Array.isArray(metadata?.normalizedBlocks)) {
    for (const block of metadata.normalizedBlocks) {
      if (block && typeof block === "object") add((block as Record<string, unknown>).image)
    }
  }
  return paths
}

export class ArtifactCleanupService {
  constructor(private readonly db: DB, private readonly clients: {
    es?: Client; graph?: Driver; imageAssetPath?: string; indexName?: string
  } = {}) {}

  private get chunkIndexName(): string {
    return resolveChunkIndexName(this.clients.indexName, this.clients.es ? undefined : loadConfig())
  }

  async run(op: CleanupOperation, document: Document): Promise<void> {
    if (op === "cleanup_pageindex") {
      this.db.prepare("DELETE FROM page_index_nodes WHERE document_id = ?")
        .run(document.id)
      return
    }
    if (op === "cleanup_neo4j") {
      await this.cleanGraph(document)
      return
    }
    if (op === "cleanup_images") {
      await this.cleanImages(document)
      return
    }
    await this.cleanChunks(document)
  }

  private async withEs<T>(action: (client: Client) => Promise<T>): Promise<T> {
    if (this.clients.es) return action(this.clients.es)
    const config = loadConfig()
    const client = createElasticsearchClient({
      node: config.esNode, apiKey: config.esApiKey || undefined,
    })
    try { return await action(client) } finally { await client.close() }
  }

  private async cleanChunks(document: Document): Promise<void> {
    await this.withEs(async (client) => {
      if (!await client.indices.exists({ index: this.chunkIndexName })) return
      const filter = [
        { term: { documentId: document.id } },
        { term: { tenantId: document.tenantId ?? "default" } },
        { term: { knowledgeBaseId: document.knowledgeBaseId ?? "" } },
      ]
      const paths = new Set<string>()
      for (let offset = 0; offset < 10_000; offset += 500) {
        const result = await client.search({ index: this.chunkIndexName,
          from: offset, size: 500, query: { bool: { filter } },
          _source: ["metadata.image", "metadata.normalizedBlocks.image"],
        })
        for (const hit of result.hits.hits) {
          for (const path of imagePaths((hit._source ?? {}) as Record<string, unknown>)) {
            paths.add(path)
          }
        }
        if (result.hits.hits.length < 500) break
        if (offset === 9_500) throw new Error("cleanup image inventory exceeds 10000 chunks")
      }
      const insert = this.db.prepare(`INSERT OR IGNORE INTO cleanup_image_assets
        (document_id, asset_path) VALUES (?, ?)`)
      this.db.transaction(() => {
        for (const path of paths) insert.run(document.id, path)
      })()
      await client.deleteByQuery({ index: this.chunkIndexName,
        query: { bool: { filter } }, conflicts: "proceed", refresh: true })
    })
  }

  private async cleanGraph(document: Document): Promise<void> {
    const driver = this.clients.graph ?? createDriver()
    const session = driver.session()
    try {
      await session.executeWrite(async (tx) => {
        const result = await tx.run(`MATCH (a)-[r:WIKILINK]->(b)
        WHERE any(p IN coalesce(r.provenance, []) WHERE p CONTAINS $documentId)
        SET r._cleanup_lock = true
        WITH a, r, b
        RETURN elementId(r) AS id, r.provenance AS provenance, r.weight AS weight,
          elementId(a) AS sourceId, elementId(b) AS targetId`,
        { documentId: document.id })
        const endpoints = new Set<string>()
        for (const record of result.records) {
          const id = record.get("id") as string
          const provenance = record.get("provenance") as string[]
          const remaining = provenance.filter((entry) => {
            try {
              const parsed = JSON.parse(entry) as unknown
              return !Array.isArray(parsed) || parsed[0] !== document.id
            } catch { return true }
          })
          if (remaining.length === provenance.length) {
            await tx.run("MATCH ()-[r:WIKILINK]->() WHERE elementId(r) = $id REMOVE r._cleanup_lock", { id })
            continue
          }
          endpoints.add(record.get("sourceId") as string)
          endpoints.add(record.get("targetId") as string)
          if (!remaining.length) {
            await tx.run("MATCH ()-[r:WIKILINK]->() WHERE elementId(r) = $id DELETE r", { id })
          } else {
            const weights = remaining.map((entry) => {
              try {
                const weight = (JSON.parse(entry) as unknown[])[4]
                return typeof weight === "number" ? weight : Number(record.get("weight") ?? 0.5)
              } catch { return Number(record.get("weight") ?? 0.5) }
            })
            await tx.run(`MATCH ()-[r:WIKILINK]->() WHERE elementId(r) = $id
            SET r.provenance = $provenance, r.weight = $weight REMOVE r._cleanup_lock`,
            { id, provenance: remaining, weight: Math.max(...weights) })
          }
        }
        await tx.run(`MATCH (e:Entity) WHERE elementId(e) IN $ids AND NOT (e)--() DELETE e`,
          { ids: [...endpoints] })
      })
    } finally { await session.close() }
  }

  private async cleanImages(document: Document): Promise<void> {
    const rows = this.db.prepare(`SELECT asset_path FROM cleanup_image_assets
      WHERE document_id = ?`).all(document.id) as Array<{ asset_path: string }>
    if (!rows.length) return
    await this.withEs(async (client) => {
      if (!await client.indices.exists({ index: this.chunkIndexName })) {
        throw new Error("cannot verify shared image references without the chunk index")
      }
      const assetRoot = resolve(this.clients.imageAssetPath ??
        loadConfig().imageAssetPath ?? join(process.cwd(), "data", "image-assets"))
      for (const { asset_path: path } of rows) {
        if (!ASSET_NAME.test(path)) throw new Error("unsafe image asset path")
        const remaining = await client.count({ index: this.chunkIndexName,
          query: { bool: { should: [
            { term: { "metadata.image.assetPath": path } },
            { term: { "metadata.image.assetPath.keyword": path } },
            { term: { "metadata.normalizedBlocks.image.assetPath": path } },
            { term: { "metadata.normalizedBlocks.image.assetPath.keyword": path } },
          ], minimum_should_match: 1 } },
        })
        if (remaining.count === 0) {
          await rm(join(assetRoot, path), { force: true })
        }
      }
      this.db.prepare("DELETE FROM cleanup_image_assets WHERE document_id = ?")
        .run(document.id)
    })
  }
}

// UT-05：完整原件接收与无效输入拦截。
//
// 准入以实际字节 + 文件名 + 现有大小限制 + 格式特征共同判定：空、上限内/
// 边界/超限、明确类型伪装（字节 vs 声明冲突）都要在进入解析前得到稳定拒绝；
// 拒绝不创建任何可运行任务、不落任何行；MIME 只是旁证，通用二进制声明不得
// 让文本样本被误判，也不能救回伪装文件。接收成功时原件字节与哈希必须等于输入。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Request, Response, NextFunction } from "express"
import { createApp } from "./server"
import { closeDb, openDb } from "../ingestion/tracking"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"

// loadConfig() 是进程级 memoize：模块加载即固定一次性隔离库。
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut05-")), "admission.db")

const tenantAccessMiddleware = (_req: Request, res: Response, next: NextFunction) => {
  res.locals.accessContext = {
    tenantId: "tenant-a",
    subjectId: "admission-user",
    groups: ["support"],
    scopes: ["ingest"],
  }
  next()
}

function startServer() {
  const eventsSource = async function* () {}
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  return server
}

function rowCount(db: ReturnType<typeof openDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

test("UT-05 空文件被稳定拒绝且不创建任何行", async () => {
  const server = startServer()
  try {
    const db = openDb()
    const before = {
      documents: rowCount(db, "documents"),
      sources: rowCount(db, "sources"),
      tasks: rowCount(db, "task_pending_ops"),
    }
    const address = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "empty.txt" },
      body: Buffer.alloc(0),
    })
    assert.equal(response.status, 400)
    const payload = await response.json() as { error: { kind: string } }
    assert.equal(payload.error.kind, "empty_file")
    assert.equal(rowCount(db, "documents"), before.documents, "拒绝不得创建文档行")
    assert.equal(rowCount(db, "sources"), before.sources, "拒绝不得创建来源行")
    assert.equal(rowCount(db, "task_pending_ops"), before.tasks, "拒绝不得创建可运行任务")
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    closeDb()
  }
})

test("UT-05 大小边界：上限内接受、超限一个字节拒绝（413 JSON）", async () => {
  const server = startServer()
  try {
    const address = server.address() as { port: number }
    const limit = 20 * 1024 * 1024
    const boundaryBody = Buffer.alloc(limit, 0x41)
    const within = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "boundary.txt" },
      body: boundaryBody,
    })
    assert.equal(within.status, 200, "恰好上限内必须被接受")

    const overBody = Buffer.alloc(limit + 1, 0x41)
    const over = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "over.txt" },
      body: overBody,
    })
    assert.equal(over.status, 413)
    const payload = await over.json() as { error: { kind: string } }
    assert.equal(payload.error.kind, "file_size")
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    closeDb()
  }
})

test("UT-05 类型伪装：文本名 + PDF/ZIP/可执行字节被 415 拒绝且零落行", async () => {
  const server = startServer()
  try {
    const db = openDb()
    const before = {
      documents: rowCount(db, "documents"),
      sources: rowCount(db, "sources"),
      tasks: rowCount(db, "task_pending_ops"),
    }
    const address = server.address() as { port: number }
    const masquerades: Array<{ name: string; body: Buffer; detected: string }> = [
      { name: "invoice.txt", body: Buffer.from("%PDF-1.7 fake pdf bytes"), detected: "binary_signature_pdf" },
      {
        name: "notes.txt",
        body: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("zip bytes")]),
        detected: "binary_signature_zip_container",
      },
      { name: "readme.txt", body: Buffer.from([0x4d, 0x5a, 0x90, 0x00]), detected: "binary_signature_windows_executable" },
    ]
    for (const masquerade of masquerades) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": masquerade.name },
        body: masquerade.body,
      })
      assert.equal(response.status, 415, masquerade.name)
      const payload = await response.json() as { error: { kind: string; detected: string } }
      assert.equal(payload.error.kind, "type_conflict")
      assert.equal(payload.error.detected, masquerade.detected)
    }
    assert.equal(rowCount(db, "documents"), before.documents)
    assert.equal(rowCount(db, "sources"), before.sources)
    assert.equal(rowCount(db, "task_pending_ops"), before.tasks)
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    closeDb()
  }
})

test("UT-05 类型伪装：声明 PDF 的文本字节被拒绝；MIME 别名不误判也不救命", async () => {
  const server = startServer()
  try {
    const address = server.address() as { port: number }
    // 文本字节 + .pdf 名 → 拒绝。
    const textAsPdf = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "fake.pdf" },
      body: Buffer.from("这只是一段普通文本，不是 PDF 结构。".repeat(10), "utf8"),
    })
    assert.equal(textAsPdf.status, 415)
    const payload = await textAsPdf.json() as { error: { detected: string } }
    assert.equal(payload.error.detected, "text_content_declared_pdf")

    // MIME 声明 text/plain 也救不了 PDF 字节的 .txt（字节决定）。
    const mimeCannotSave = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "report.txt",
        "x-file-mime-type": "text/plain",
      },
      body: Buffer.from("%PDF-1.4 hidden pdf"),
    })
    assert.equal(mimeCannotSave.status, 415)

    // 通用二进制声明（octet-stream）不会让正常文本被误判。
    const genericMime = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "plain.txt",
        "x-file-mime-type": "application/octet-stream",
      },
      body: Buffer.from("普通文本内容，通用 MIME 不构成伪装。", "utf8"),
    })
    assert.equal(genericMime.status, 200, "octet-stream + 文本字节 + 文本名 = 正常接收")
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    closeDb()
  }
})

test("UT-05 无法确认的类型在准入被拒（不创建可运行任务去白白消耗解析重试）", async () => {
  const server = startServer()
  try {
    const db = openDb()
    const before = rowCount(db, "documents")
    const address = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "mystery.qqq" },
      body: Buffer.from("some content", "utf8"),
    })
    assert.equal(response.status, 415)
    const payload = await response.json() as { error: { kind: string } }
    assert.equal(payload.error.kind, "unsupported_type")
    assert.equal(rowCount(db, "documents"), before, "不创建任何行")
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    closeDb()
  }
})

test("UT-05 接收完整性：成功接收的原件字节与哈希等于输入", async () => {
  const server = startServer()
  try {
    const address = server.address() as { port: number }
    const body = Buffer.from("原件完整性校验内容 — original bytes integrity. 42", "utf8")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "integrity.txt" },
      body,
    })
    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string }
    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.ok(document)
    assert.deepEqual(document.rawContent, body, "保存的原件字节必须与输入逐字节一致")
    assert.equal(
      document.contentHash,
      createHash("sha256").update(body).digest("hex"),
      "登记的内容哈希必须等于输入字节的 sha256"
    )
    assert.equal(document.fileName, "integrity.txt")
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    closeDb()
  }
})

test("UT-05 回归：合法 PDF 字节按 .pdf 接收，归属与意图语义不变", async () => {
  const server = startServer()
  try {
    const address = server.address() as { port: number }
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "latin1"),
      Buffer.from("1 0 obj << /Type /Catalog >> endobj\ntrailer<<>>\n%%EOF", "latin1"),
    ])
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "real.pdf",
        "x-source-id": "C:/admission/real.pdf",
        "x-document-intent": "new_document",
      },
      body: pdfBytes,
    })
    assert.equal(response.status, 200, "真实 PDF 字节不被新校验误伤")
    const submitted = await response.json() as { docId: string; knowledgeBaseId: string }
    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.ok(document)
    assert.equal(document.mimeType, "application/octet-stream")
    assert.deepEqual(document.rawContent, pdfBytes)
    assert.ok(submitted.knowledgeBaseId.startsWith("kb-default-"), "缺省归属仍是租户默认库")
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    closeDb()
  }
})

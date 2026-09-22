import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import test from "node:test"
import { createApp } from "./server"
import { closeDb, openDb } from "../ingestion/tracking"
import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { _setTestDefaults } from "../ingestion/url_fetcher"
import type { HostResolver } from "../ingestion/url_policy"
import type { AnswerEventsSource } from "./chat"
import type { RequestHandler } from "express"

const eventsSource: AnswerEventsSource = async function* () {}

const PUBLIC_IP = "93.184.216.34"

const tenantAccessMiddleware: RequestHandler = (_req, res, next) => {
  res.locals.accessContext = {
    tenantId: "tenant-a",
    subjectId: "support-user",
    groups: ["support"],
    scopes: ["ingest"],
  }
  next()
}

const adminAccessMiddleware: RequestHandler = (_req, res, next) => {
  res.locals.accessContext = {
    tenantId: "tenant-a",
    subjectId: "tenant-admin",
    groups: ["tenant-admins"],
    scopes: ["chat", "ingest", "review", "admin"],
  }
  next()
}

/** 合成 resolver：将 public.test 解析为公网 IP，绕过 SSRF 策略的 IP 校验。 */
const PUBLIC_TEST_RESOLVER: HostResolver = async (hostname) => {
  if (hostname === "public.test" || hostname === "error.test") {
    return { addresses: [PUBLIC_IP] }
  }
  throw new Error(`no synthetic resolution for ${hostname}`)
}

test("raw file ingestion accepts bounded bytes and file metadata before JSON parsing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-api-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)

  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "policy.docx",
        "x-file-mime-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "x-parser": "markitdown",
        "x-source-kind": "file",
        "x-source-id": "C:/knowledge/policy.docx",
        "x-source-namespace": "local",
        "x-tenant-id": "attacker-tenant",
      },
      body: Buffer.from([0x00, 0xff, 0x41]),
    })

    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string; status: string }
    assert.equal(submitted.status, "pending")
    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.equal(document?.fileName, "policy.docx")
    assert.equal(
      document?.mimeType,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    assert.equal(document?.parserOverride, "markitdown")
    assert.deepEqual(document?.rawContent, Buffer.from([0x00, 0xff, 0x41]))
    assert.equal(document?.tenantId, "tenant-a")
    assert.deepEqual(document?.allowedGroups, ["support"])
    const source = openDb().prepare(
      "SELECT tenant_id, allowed_groups FROM sources WHERE source_id = ?"
    ).get(document!.sourceId) as { tenant_id: string; allowed_groups: string }
    assert.equal(source.tenant_id, "tenant-a")
    assert.deepEqual(JSON.parse(source.allowed_groups), ["support"])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an admin-scope import is tenant-wide instead of admin-private (KB-05B)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-api-admin-import-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({ eventsSource, ingestAccessMiddleware: adminAccessMiddleware }).listen(0)

  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Policy", content: "Tenant-wide import" }),
    })
    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string }
    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.equal(document?.tenantId, "tenant-a")
    // The admin curates knowledge for the WHOLE tenant: empty allowedGroups
    // means every same-tenant caller passes the group filter, reader accounts
    // included. Stamping ["tenant-admins"] here left readers with no evidence.
    assert.deepEqual(document?.allowedGroups, [])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("JSON ingestion replaces caller-supplied ACL metadata with trusted access context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-api-acl-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({
    eventsSource,
    ingestAccessMiddleware: tenantAccessMiddleware,
  }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Policy",
        content: "Trusted ACL",
        sourceIdentity: {
          kind: "file",
          uriOrExternalId: "C:/knowledge/policy.txt",
          namespace: "upload",
          tenantId: "attacker-tenant",
          allowedGroups: ["attacker-group"],
        },
      }),
    })
    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string }
    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.equal(document?.tenantId, "tenant-a")
    assert.deepEqual(document?.allowedGroups, ["support"])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url single mode fetches a URL and submits raw bytes to the lifecycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 准备一个本地 HTTP 服务器，返回一段 HTML
  const html = `<!DOCTYPE html><html><head><title>测试文档</title></head><body><h1>hello</h1></body></html>`
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddr = upstream.address()
  assert.ok(upstreamAddr && typeof upstreamAddr === "object")
  const upstreamPort = upstreamAddr.port

  // P4.2: 注入合成 resolver + fetchImpl，使策略校验通过（public.test → 公网 IP），
  // 同时将实际 HTTP 请求重定向到本地测试服务器。
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const localUrl = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`
    return fetch(localUrl, init)
  }
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://public.test/article`,
      }),
    })
    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string; status: string }
    assert.equal(submitted.status, "pending")

    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.equal(document?.fileName, "article.html")
    assert.equal(document?.mimeType, "text/html")
    assert.equal(document?.title, "测试文档")
    assert.deepEqual(document?.rawContent, Buffer.from(html, "utf8"))
    assert.equal(document?.tenantId, "tenant-a")
    assert.deepEqual(document?.allowedGroups, ["support"])
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url rejects invalid url with 400", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-invalid-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.match(body.error, /valid absolute URL/i)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url rejects non-http protocols with 400", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-proto-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.match(body.error, /http or https/i)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url returns 502 when upstream fetch fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-502-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // P4.2: 注入合成 fetchImpl 模拟连接失败（策略校验通过后 fetch 抛错）。
  const fetchImpl: typeof fetch = () =>
    Promise.reject(new Error("ECONNREFUSED synthetic"))
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://error.test/nope" }),
    })
    assert.equal(response.status, 502)
    const body = await response.json() as { error: string; detail: string }
    assert.match(body.error, /failed to fetch url/i)
    assert.match(body.detail, /fetch failed/i)
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url sitemap mode parses sitemap and submits each page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-sitemap-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // P4.2: 使用单个本地服务器同时提供 sitemap.xml 和页面内容。
  // sitemap.xml 中的 URL 使用 public.test，通过合成 resolver 解析为公网 IP。
  const pageHtml = `<!DOCTYPE html><html><head><title>页面</title></head><body><p>内容</p></body></html>`
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://public.test/p1</loc></url>
  <url><loc>http://public.test/p2</loc></url>
</urlset>`

  const upstream = createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" })
      res.end(sitemapXml)
    } else {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(pageHtml)
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddr = upstream.address()
  assert.ok(upstreamAddr && typeof upstreamAddr === "object")
  const upstreamPort = upstreamAddr.port

  // P4.2: 注入合成 resolver + fetchImpl，使策略校验通过，
  // 同时将实际 HTTP 请求重定向到本地测试服务器。
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const localUrl = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`
    return fetch(localUrl, init)
  }
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://public.test/sitemap.xml`,
        mode: "sitemap",
        maxPages: 5,
      }),
    })
    assert.equal(response.status, 200)
    const result = await response.json() as {
      batchId: string
      mode: string
      total: number
      submitted: number
      failed: number
      items: { url: string; docId: string; status: string }[]
    }
    assert.equal(result.mode, "sitemap")
    assert.equal(result.total, 2)
    assert.equal(result.submitted, 2)
    assert.equal(result.failed, 0)
    assert.match(result.batchId, /^sitemap-/)
    assert.equal(result.items.length, 2)
    for (const item of result.items) {
      assert.ok(item.docId, "每个成功项应有 docId")
      assert.equal(item.status, "pending")
      const document = new DocumentRepo(openDb()).get(item.docId)
      assert.equal(document?.tenantId, "tenant-a")
      assert.deepEqual(document?.allowedGroups, ["support"])
    }
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

// --- P4.3 ingestion lifecycle integration 测试 ---
// SSRF 拒绝 (UrlPolicyDenyError) 必须可 inspectable 且 retry-safe（non-retryable）。
// Transient fetch error 必须 retryable。两者通过 HTTP 状态码 (422 vs 502) 和
// 响应体 retryable 字段区分。

test("P4.3: SSRF rejection returns 422 with inspectable decision reason (non-retryable)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-ssrf-422-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 不注入合成 resolver — 让真实策略拒绝 loopback URL (127.0.0.1)。
  // fetchImpl 即使被调用也不应到达（策略校验在 fetch 之前）。
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("should not reach", { status: 200 }))
  }
  _setTestDefaults({ fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/secret" }),
    })
    assert.equal(response.status, 422)
    const body = await response.json() as {
      error: string
      reason: string
      detail: string
      stage: string
      hop: number
      retryable: boolean
    }
    assert.equal(body.error, "url policy denied")
    assert.equal(body.reason, "ip_denied_loopback")
    assert.ok(body.detail.includes("127.0.0.1"), "detail should contain the denied IP")
    assert.equal(body.stage, "initial")
    assert.equal(body.hop, 0)
    assert.equal(body.retryable, false, "SSRF rejection must be non-retryable")
    assert.equal(fetchCalled, false, "fetch must NOT be called for SSRF-denied URL")
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4.3: transient fetch error returns 502 with retryable=true", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-502-retry-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 注入合成 resolver 使策略校验通过，但 fetchImpl 抛 ECONNREFUSED（transient）。
  const fetchImpl: typeof fetch = () =>
    Promise.reject(new Error("ECONNREFUSED synthetic"))
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://error.test/nope" }),
    })
    assert.equal(response.status, 502)
    const body = await response.json() as {
      error: string
      detail: string
      retryable: boolean
    }
    assert.match(body.error, /failed to fetch url/i)
    assert.match(body.detail, /fetch failed/i)
    assert.equal(body.retryable, true, "transient fetch error must be retryable")
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4.3: SSRF rejection at redirect stage carries stage=redirect in 422 response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-ssrf-redirect-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 合成 fetch：首次返回 301 重定向到 127.0.0.1（loopback）。
  // 策略校验在重定向阶段拒绝 → UrlPolicyDenyError(stage=redirect, hop=1)。
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(null, {
        status: 301,
        headers: { location: "http://127.0.0.1/secret" },
      }),
    )
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://public.test/article" }),
    })
    assert.equal(response.status, 422)
    const body = await response.json() as {
      error: string
      reason: string
      stage: string
      hop: number
      retryable: boolean
    }
    assert.equal(body.error, "url policy denied")
    assert.equal(body.reason, "ip_denied_loopback")
    assert.equal(body.stage, "redirect", "stage must be redirect for redirect-stage denial")
    assert.equal(body.hop, 1)
    assert.equal(body.retryable, false)
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4.3: sitemap mode marks SSRF-denied pages as ssrf_denied with retryable=false", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-sitemap-ssrf-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // sitemap.xml 包含两个 URL：一个 public（成功），一个 loopback（SSRF 拒绝）。
  const pageHtml = `<!DOCTYPE html><html><head><title>页面</title></head><body><p>内容</p></body></html>`
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://public.test/p1</loc></url>
  <url><loc>http://127.0.0.1/secret</loc></url>
</urlset>`

  const upstream = createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" })
      res.end(sitemapXml)
    } else {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(pageHtml)
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddr = upstream.address()
  assert.ok(upstreamAddr && typeof upstreamAddr === "object")
  const upstreamPort = upstreamAddr.port

  // 合成 fetchImpl：将 public.test 的请求重定向到本地服务器。
  // 127.0.0.1 的请求不会被调用（策略在 fetch 前拒绝）。
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const localUrl = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`
    return fetch(localUrl, init)
  }
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://public.test/sitemap.xml`,
        mode: "sitemap",
        maxPages: 5,
      }),
    })
    assert.equal(response.status, 200)
    const result = await response.json() as {
      batchId: string
      mode: string
      total: number
      submitted: number
      failed: number
      items: { url: string; docId: string; status: string; retryable: boolean }[]
    }
    assert.equal(result.total, 2)
    assert.equal(result.submitted, 1, "only the public URL should be submitted")
    assert.equal(result.failed, 1, "the SSRF-denied URL should be counted as failed")

    const ssrfItem = result.items.find((i) => i.url === "http://127.0.0.1/secret")
    assert.ok(ssrfItem, "SSRF-denied item should be in the result")
    assert.equal(ssrfItem!.docId, "", "SSRF-denied item should have empty docId")
    assert.match(ssrfItem!.status, /ssrf_denied: ip_denied_loopback/)
    assert.equal(ssrfItem!.retryable, false, "SSRF-denied item must be non-retryable")

    const okItem = result.items.find((i) => i.url === "http://public.test/p1")
    assert.ok(okItem, "successful item should be in the result")
    assert.ok(okItem!.docId, "successful item should have docId")
    assert.equal(okItem!.retryable, false, "successful item is not retryable (already submitted)")
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

// --- Ticket 03 (KB-02A) knowledge-base ownership ---
// 每个导入必须恰好落在一个已授权知识库上：字段缺省 → 该租户的确定性默认库；
// 显式 id 必须存在且属于本租户（未知/跨租户 404、空白 400），绝不静默放宽为“所有库”。

/** 直接建库（不走 HTTP），用于给显式 knowledgeBaseId 提供合法目标。 */
function seedKnowledgeBase(db: DB, id: string, tenantId: string): void {
  new SqliteKnowledgeBaseRepo(db).insertIfAbsent({
    id,
    tenantId,
    name: id,
    description: "",
    status: "active",
    embeddingProfile: "test-model:2",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })
}

test("Ticket 03 KB-02A: a text import without a knowledge base resolves to the tenant default", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-kb-default-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Policy",
        content: "no knowledge base field",
        source: "https://example.com/policy",
      }),
    })
    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string; knowledgeBaseId: string }
    assert.equal(submitted.knowledgeBaseId, "kb-default-tenant-a")

    const db = openDb()
    const document = new DocumentRepo(db).get(submitted.docId)
    assert.equal(document?.knowledgeBaseId, "kb-default-tenant-a")
    const source = db.prepare(
      "SELECT knowledge_base_id FROM sources WHERE source_id = ?"
    ).get(document!.sourceId) as { knowledge_base_id: string }
    assert.equal(source.knowledge_base_id, "kb-default-tenant-a")
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 03 KB-02A: an explicit knowledge base owns the import and splits source identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-kb-scoped-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const db = openDb()
  seedKnowledgeBase(db, "kb-policies", "tenant-a")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const submit = async (body: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 200)
      return response.json() as Promise<{ docId: string; knowledgeBaseId: string }>
    }
    const sameContent = { title: "Policy", content: "identical bytes", source: "https://example.com/policy" }

    const scoped = await submit({ ...sameContent, knowledgeBaseId: "kb-policies" })
    assert.equal(scoped.knowledgeBaseId, "kb-policies")
    const fallback = await submit(sameContent)
    assert.equal(fallback.knowledgeBaseId, "kb-default-tenant-a")

    // criterion 2: 同一份内容落在两个库里 = 两个 Source 身份、两个 Document，
    // 而不是被后一次导入收养（"unchanged"）成同一个。
    const repo = new DocumentRepo(db)
    const scopedDoc = repo.get(scoped.docId)
    const fallbackDoc = repo.get(fallback.docId)
    assert.equal(scopedDoc?.knowledgeBaseId, "kb-policies")
    assert.equal(fallbackDoc?.knowledgeBaseId, "kb-default-tenant-a")
    assert.notEqual(scoped.docId, fallback.docId)
    assert.notEqual(scopedDoc?.sourceId, fallbackDoc?.sourceId)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 03 KB-02A: file imports read x-knowledge-base-id and fail loudly on bad ids", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-kb-file-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const db = openDb()
  seedKnowledgeBase(db, "kb-policies", "tenant-a")
  seedKnowledgeBase(db, "kb-other", "tenant-b")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const upload = (knowledgeBaseId?: string, sourceId = "C:/knowledge/policy.txt") =>
      fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": "policy.txt",
          "x-source-id": sourceId,
          "x-source-namespace": "local",
          ...(knowledgeBaseId === undefined ? {} : { "x-knowledge-base-id": knowledgeBaseId }),
        },
        body: Buffer.from(`file bytes for ${sourceId}`),
      })

    const scopedResponse = await upload("kb-policies")
    assert.equal(scopedResponse.status, 200)
    const scoped = await scopedResponse.json() as { docId: string; knowledgeBaseId: string }
    assert.equal(scoped.knowledgeBaseId, "kb-policies")
    assert.equal(new DocumentRepo(db).get(scoped.docId)?.knowledgeBaseId, "kb-policies")

    // 无 header → 默认库（旧调用方继续可用）。
    const defaultResponse = await upload(undefined, "C:/knowledge/legacy.txt")
    assert.equal(defaultResponse.status, 200)
    const defaulted = await defaultResponse.json() as { knowledgeBaseId: string }
    assert.equal(defaulted.knowledgeBaseId, "kb-default-tenant-a")

    // 未知 id 与跨租户 id 都是 404（两者不可区分，不能用来探测别的租户）。
    for (const id of ["kb-missing", "kb-other"]) {
      const denied = await upload(id, `C:/knowledge/${id}.txt`)
      assert.equal(denied.status, 404, `${id} must be rejected`)
      assert.deepEqual(await denied.json(), { error: "knowledge base not found" })
    }

    // 空白 id 是 400，而不是被当成“未提供”而回退默认库。
    const blank = await upload("   ", "C:/knowledge/blank.txt")
    assert.equal(blank.status, 400)
    const blankBody = await blank.json() as { error: string }
    assert.match(blankBody.error, /non-empty string/i)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 03 KB-02A: text imports fail loudly on unknown, cross-tenant or malformed ids", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-kb-json-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const db = openDb()
  seedKnowledgeBase(db, "kb-other", "tenant-b")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const submit = (knowledgeBaseId: unknown) =>
      fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Policy",
          content: `content for ${JSON.stringify(knowledgeBaseId)}`,
          source: "https://example.com/policy",
          knowledgeBaseId,
        }),
      })

    // 该文件里的 SQLITE_PATH 只在进程首次 loadConfig 时生效，所以这里复用的
    // 可能是前序用例留下的库：只能比较「前后差值」，不能断言绝对值为 0。
    const countRows = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    const before = { documents: countRows("documents"), sources: countRows("sources") }

    // 未知 id 与跨租户 id 都是 404，两者不可区分。
    for (const id of ["kb-missing", "kb-other"]) {
      const denied = await submit(id)
      assert.equal(denied.status, 404, `${id} must be rejected`)
      assert.deepEqual(await denied.json(), { error: "knowledge base not found" })
    }

    // 空白与「非字符串」都是 400：非字符串尤其不能被当成“未提供”而落到默认库。
    for (const malformed of ["   ", 123]) {
      const rejected = await submit(malformed)
      assert.equal(rejected.status, 400, `${JSON.stringify(malformed)} must be rejected`)
      const body = await rejected.json() as { error: string }
      assert.match(body.error, /non-empty string/i)
    }

    // 被拒绝的导入没有留下任何产物（document 与 source 都没有新增）。
    assert.deepEqual(
      { documents: countRows("documents"), sources: countRows("sources") },
      before
    )
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

// --- Ticket 04 (KB-02B) URL/sitemap knowledge-base ownership ---
// URL 入口必须与 /ingest、/ingest/file 用同一份归属契约：缺省 → 默认库；
// 显式 id 必须存在且属于本租户；同一 URL 进两个库是两条独立身份。

/** 把 public.test 的请求转到本地测试服务器，其余交给注入的 fetchImpl。 */
function localFetchImpl(port: number): typeof fetch {
  return (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init)
  }
}

const URL_IMPORT_HTML = `<!DOCTYPE html><html><head><title>政策</title></head><body><p>内容</p></body></html>`

async function withLocalUpstream(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const upstream = createServer(handler)
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address === "object")
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  }
}

function knowledgeBaseIdOfSource(db: DB, sourceId: string): string {
  return (
    db.prepare("SELECT knowledge_base_id FROM sources WHERE source_id = ?").get(sourceId) as
      { knowledge_base_id: string }
  ).knowledge_base_id
}

test("Ticket 04 KB-02B: URL imports carry ownership and the same URL in two bases stays independent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-kb-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  const upstream = await withLocalUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(URL_IMPORT_HTML)
  })
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl: localFetchImpl(upstream.port) })

  const db = openDb()
  seedKnowledgeBase(db, "kb-policies", "tenant-a")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const submit = async (body: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 200)
      return response.json() as Promise<{ docId: string; status: string; knowledgeBaseId: string }>
    }

    const sameUrl = "http://public.test/policy"
    const scoped = await submit({ url: sameUrl, knowledgeBaseId: "kb-policies" })
    assert.equal(scoped.knowledgeBaseId, "kb-policies")
    // 缺省字段 → 该租户的确定性默认库，旧调用方继续可用。
    const fallback = await submit({ url: sameUrl })
    assert.equal(fallback.knowledgeBaseId, "kb-default-tenant-a")

    // criterion 2: 同一 URL 落在两个库里 = 两个 Source 身份、两个 Document，
    // 而不是被后一次导入收养成同一个。
    const repo = new DocumentRepo(db)
    const scopedDoc = repo.get(scoped.docId)
    const fallbackDoc = repo.get(fallback.docId)
    assert.equal(scopedDoc?.knowledgeBaseId, "kb-policies")
    assert.equal(fallbackDoc?.knowledgeBaseId, "kb-default-tenant-a")
    assert.notEqual(scoped.docId, fallback.docId)
    assert.notEqual(scopedDoc?.sourceId, fallbackDoc?.sourceId)
    assert.equal(knowledgeBaseIdOfSource(db, scopedDoc!.sourceId), "kb-policies")
    assert.equal(knowledgeBaseIdOfSource(db, fallbackDoc!.sourceId), "kb-default-tenant-a")
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await upstream.close()
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 04 KB-02B: URL imports reject bad ids before any outbound fetch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-kb-bad-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 归属解析必须发生在 fetch 之前：被拒绝的导入不应产生任何出网请求。
  let fetchCalls = 0
  const fetchImpl: typeof fetch = () => {
    fetchCalls += 1
    return Promise.resolve(
      new Response(URL_IMPORT_HTML, { status: 200, headers: { "content-type": "text/html" } })
    )
  }
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const db = openDb()
  seedKnowledgeBase(db, "kb-other", "tenant-b")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const submit = (knowledgeBaseId: unknown, mode?: "sitemap") =>
      fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "http://public.test/policy",
          knowledgeBaseId,
          ...(mode ? { mode } : {}),
        }),
      })

    const countRows = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    const before = { documents: countRows("documents"), sources: countRows("sources") }

    // 未知 id 与跨租户 id 都是 404（不可区分，不能用来探测别的租户）。
    for (const id of ["kb-missing", "kb-other"]) {
      const denied = await submit(id)
      assert.equal(denied.status, 404, `${id} must be rejected`)
      assert.deepEqual(await denied.json(), { error: "knowledge base not found" })
    }

    // 空白与「非字符串」都是 400：非字符串尤其不能被当成“未提供”而落到默认库。
    for (const malformed of ["   ", 123]) {
      const rejected = await submit(malformed)
      assert.equal(rejected.status, 400, `${JSON.stringify(malformed)} must be rejected`)
      const body = await rejected.json() as { error: string }
      assert.match(body.error, /non-empty string/i)
    }

    // sitemap 入口走同一份归属契约：坏 id 在抓取 sitemap.xml 之前就被拒绝。
    const sitemapDenied = await submit("kb-missing", "sitemap")
    assert.equal(sitemapDenied.status, 404)
    assert.deepEqual(await sitemapDenied.json(), { error: "knowledge base not found" })

    assert.equal(fetchCalls, 0, "被拒绝的 URL 导入不得发起任何出网请求")
    assert.deepEqual(
      { documents: countRows("documents"), sources: countRows("sources") },
      before
    )
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 04 KB-02B: every sitemap page is filed under the resolved knowledge base", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-sitemap-kb-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://public.test/p1</loc></url>
  <url><loc>http://public.test/p2</loc></url>
</urlset>`
  const upstream = await withLocalUpstream((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" })
      res.end(sitemapXml)
    } else {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(URL_IMPORT_HTML)
    }
  })
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl: localFetchImpl(upstream.port) })

  const db = openDb()
  seedKnowledgeBase(db, "kb-policies", "tenant-a")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://public.test/sitemap.xml",
        mode: "sitemap",
        maxPages: 5,
        knowledgeBaseId: "kb-policies",
      }),
    })
    assert.equal(response.status, 200)
    const result = await response.json() as {
      knowledgeBaseId: string
      submitted: number
      items: { url: string; docId: string }[]
    }
    assert.equal(result.knowledgeBaseId, "kb-policies")
    assert.equal(result.submitted, 2)

    // 整批共享同一个已解析的知识库：每个页面的 Document 与 Source 都归属它。
    const repo = new DocumentRepo(db)
    for (const item of result.items) {
      const document = repo.get(item.docId)
      assert.equal(document?.knowledgeBaseId, "kb-policies", `${item.url} 应归属 kb-policies`)
      assert.equal(knowledgeBaseIdOfSource(db, document!.sourceId), "kb-policies")
    }
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await upstream.close()
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 08 KB-04: an import naming an archived knowledge base is refused with 409", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-kb-archived-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const db = openDb()
  seedKnowledgeBase(db, "kb-policies", "tenant-a")
  // 归档（KB-04 之后：归档库停止加入新检索，导入也不许落进去）。
  new SqliteKnowledgeBaseRepo(db).setStatus(
    "kb-policies",
    "tenant-a",
    "archived",
    "2026-09-22T00:00:00.000Z",
  )
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const countRows = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    const before = { documents: countRows("documents"), sources: countRows("sources") }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Policy",
        content: "into an archived base",
        source: "https://example.com/policy",
        knowledgeBaseId: "kb-policies",
      }),
    })
    assert.equal(response.status, 409, "archived is a state conflict, not a 500")
    const body = await response.json() as { error: string }
    assert.match(body.error, /archived/i)

    // 被拒绝的导入没有留下任何产物。
    assert.deepEqual(
      { documents: countRows("documents"), sources: countRows("sources") },
      before,
    )
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 11 DOC-01A: imports carry tags and folder into the document metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-doc-catalog-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const db = openDb()
  seedKnowledgeBase(db, "kb-catalog", "tenant-a")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    // Text import with catalog metadata.
    const textRes = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Policy",
        content: "catalog metadata",
        knowledgeBaseId: "kb-catalog",
        tags: ["policy", "policy", " hr "],
        folder: "HR",
      }),
    })
    assert.equal(textRes.status, 200)
    const textSubmitted = await textRes.json() as { docId: string }
    const repo = new DocumentRepo(db)
    const textDoc = repo.get(textSubmitted.docId)
    assert.deepEqual(textDoc?.metadata.tags, ["policy", "hr"], "tags are trimmed and deduped")
    assert.equal(textDoc?.metadata.folder, "HR")

    // File import with catalog metadata via headers.
    const fileRes = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "notes.md",
        "x-knowledge-base-id": "kb-catalog",
        "x-document-tags": "notes, draft",
        "x-document-folder": "Meetings",
      },
      body: Buffer.from("meeting notes"),
    })
    assert.equal(fileRes.status, 200)
    const fileSubmitted = await fileRes.json() as { docId: string }
    const fileDoc = repo.get(fileSubmitted.docId)
    assert.deepEqual(fileDoc?.metadata.tags, ["notes", "draft"])
    assert.equal(fileDoc?.metadata.folder, "Meetings")

    // Malformed catalog metadata is a 400 and files nothing.
    const badRes = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad",
        content: "nested folder",
        knowledgeBaseId: "kb-catalog",
        folder: "HR/2026",
      }),
    })
    assert.equal(badRes.status, 400, "a one-level folder rejects separators")
    const badTagsRes = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad",
        content: "tags are strings",
        knowledgeBaseId: "kb-catalog",
        tags: ["policy", 7],
      }),
    })
    assert.equal(badTagsRes.status, 400, "non-string tags are rejected")
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 12 DOC-01B: same-name content requires explicit version-or-new-document intent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-intent-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const db = openDb()
  seedKnowledgeBase(db, "kb-intent", "tenant-a")
  const server = createApp({ eventsSource, ingestAccessMiddleware: adminAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const upload = (content: string, intent?: string) =>
      fetch(`http://127.0.0.1:${address!.port}/api/ingest/file`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": "handbook.md",
          "x-knowledge-base-id": "kb-intent",
          ...(intent ? { "x-document-intent": intent } : {}),
        },
        body: Buffer.from(content),
      })

    // First upload — a brand-new source needs no intent.
    const first = await upload("version one")
    assert.equal(first.status, 200)
    const firstBody = await first.json() as { docId: string; version: number }
    assert.equal(firstBody.version, 1)
    // No worker runs in this test — activate the version the pipeline's
    // success path would have activated.
    new DocumentRepo(db).activate(firstBody.docId)

    // Identical content stays an "unchanged" no-op without intent.
    const same = await upload("version one")
    assert.equal(same.status, 200)
    assert.equal((await same.json() as { status: string }).status, "unchanged")

    // Different content without intent is a 409 that names the active version.
    const conflict = await upload("version two")
    assert.equal(conflict.status, 409)
    const conflictBody = await conflict.json() as { activeDocId: string; activeVersion: number }
    assert.equal(conflictBody.activeDocId, firstBody.docId)
    assert.equal(conflictBody.activeVersion, 1)

    // An invalid intent is a 400.
    assert.equal((await upload("version two", "nonsense")).status, 400)

    // Explicit new_version rides the same source's version history.
    const replacement = await upload("version two", "new_version")
    assert.equal(replacement.status, 200)
    assert.equal((await replacement.json() as { version: number }).version, 2)

    // Explicit new_document detaches into an independent source (version 1).
    const independent = await upload("version three", "new_document")
    assert.equal(independent.status, 200)
    const independentBody = await independent.json() as { docId: string; version: number }
    assert.equal(independentBody.version, 1)
    assert.notEqual(independentBody.docId, firstBody.docId)
    const repo = new DocumentRepo(db)
    assert.notEqual(repo.get(independentBody.docId)?.sourceId, repo.get(firstBody.docId)?.sourceId)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Ticket 12 DOC-01B: retry and reprocess reuse the lifecycle and are admin+tenant scoped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-retry-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const db = openDb()
  const repo = new DocumentRepo(db)
  const taskRepo = new TaskRepo(db)

  const makeDoc = (tenantId: string, title: string, status: "failed" | "completed") => {
    const source = repo.createSource({
      sourceId: `src-${Math.random().toString(16).slice(2, 8)}`,
      sourceKey: `key-${Math.random().toString(16).slice(2, 8)}`,
      kind: "submission",
      uri: `uri-${Math.random().toString(16).slice(2, 8)}`,
      namespace: "test",
      tenantId,
    })
    const docId = `doc-${Math.random().toString(16).slice(2, 8)}`
    repo.insert({ docId, sourceId: source.sourceId, contentHash: `h-${docId}`, version: 1, title, source: "api", content: "x", tenantId })
    const taskId = taskRepo.enqueue({ docId, op: "ingest", payload: {} })
    // Simulate a terminal task. (claimNext would grab stale pending tasks from
    // earlier tests — openDb() is memoized across this file — so set the state
    // directly.)
    db.prepare("UPDATE task_pending_ops SET status = ? WHERE id = ?").run(status, taskId)
    repo.updateStatus(docId, status)
    return docId
  }

  const failedDoc = makeDoc("tenant-a", "Broken", "failed")
  const completedDoc = makeDoc("tenant-a", "Done", "completed")
  const foreignDoc = makeDoc("tenant-b", "Foreign", "failed")
  // A retired source's document must not be resurrectable.
  const retiredDoc = makeDoc("tenant-a", "Retired", "failed")
  db.prepare(`UPDATE sources SET lifecycle_state = 'retired' WHERE source_id = (
    SELECT source_id FROM documents WHERE doc_id = ?)`).run(retiredDoc)

  const server = createApp({ eventsSource, ingestAccessMiddleware: adminAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const port = (server.address() as { port: number }).port

    // Non-admin callers are refused before anything else.
    const readerServer = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
    const readerPort = (readerServer.address() as { port: number }).port
    try {
      const readerRes = await fetch(`http://127.0.0.1:${readerPort}/api/ingest/${failedDoc}/retry`, { method: "POST" })
      assert.equal(readerRes.status, 403)
    } finally {
      await new Promise<void>((resolve) => readerServer.close(() => resolve()))
    }

    // Another tenant's doc id is the same 404 a missing one is.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ingest/${foreignDoc}/status`)).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ingest/${foreignDoc}/retry`, { method: "POST" })).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ingest/does-not-exist/reprocess`, { method: "POST" })).status, 404)

    // A retired source's document stays retired — no resurrection.
    const retiredRes = await fetch(`http://127.0.0.1:${port}/api/ingest/${retiredDoc}/retry`, { method: "POST" })
    assert.equal(retiredRes.status, 409)
    assert.equal(repo.getStatus(retiredDoc), "failed", "the retired doc was not requeued")

    // Retry the failed doc: task requeued (fail budget reset), doc pending.
    const retryRes = await fetch(`http://127.0.0.1:${port}/api/ingest/${failedDoc}/retry`, { method: "POST" })
    assert.equal(retryRes.status, 200)
    assert.equal((await retryRes.json() as { changed: boolean }).changed, true)
    assert.equal(taskRepo.getByDocId(failedDoc)?.status, "pending")
    assert.equal(taskRepo.getByDocId(failedDoc)?.failCount, 0)
    assert.equal(repo.getStatus(failedDoc), "pending")
    // Retry again is a state conflict (already pending), not a 500.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ingest/${failedDoc}/retry`, { method: "POST" })).status, 409)

    // Reprocess the completed doc; reprocessing a pending doc is a conflict.
    const reprocessRes = await fetch(`http://127.0.0.1:${port}/api/ingest/${completedDoc}/reprocess`, { method: "POST" })
    assert.equal(reprocessRes.status, 200)
    assert.equal((await reprocessRes.json() as { changed: boolean }).changed, true)
    assert.equal(taskRepo.getByDocId(completedDoc)?.status, "pending")
    assert.equal(repo.getStatus(completedDoc), "pending")
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ingest/${completedDoc}/reprocess`, { method: "POST" })).status, 409)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ingest/${failedDoc}/reprocess`, { method: "POST" })).status, 409)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

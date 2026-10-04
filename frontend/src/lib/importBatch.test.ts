import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildImportRows,
  categoryForPath,
  countActiveImports,
  describeImportError,
  findReusableKnowledgeBase,
  flattenFolderNode,
  freezeWaveParams,
  isPdfLike,
  isSupportedFileName,
  matchExistingFileNames,
  partitionLooseFiles,
  retryDecision,
  sanitizeKnowledgeBaseName,
  serverUploadErrorKind,
  settleWavePrecheck,
  type FolderNode,
  type PrecheckSettleRow,
} from "./importBatch"

function fakeFile(name: string, size = 10): File {
  // Node 20+ ships File globally; the import logic only reads name and size.
  return new File(["x".repeat(size)], name)
}

describe("format filtering", () => {
  it("accepts every whitelisted extension case-insensitively", () => {
    assert.equal(isSupportedFileName("手册.PDF"), true)
    assert.equal(isSupportedFileName("photo.Heic"), true)
    assert.equal(isSupportedFileName("data.csv"), true)
    assert.equal(isSupportedFileName("virus.exe"), false)
    assert.equal(isSupportedFileName("no-extension"), false)
  })

  it("partitions loose files and counts the skipped ones", () => {
    const result = partitionLooseFiles([
      { file: fakeFile("a.pdf") },
      { file: fakeFile("b.exe") },
      { file: fakeFile("c.csv"), relativePath: "uploads/c.csv" },
      { file: fakeFile("noext") },
    ])
    assert.deepEqual(
      result.files.map((picked) => picked.relativePath),
      ["a.pdf", "uploads/c.csv"],
    )
    assert.equal(result.skipped, 2)
  })

  it("flattens a nested folder tree with root-prefixed paths", () => {
    const tree: FolderNode = {
      name: "产品手册",
      files: [{ name: "readme.txt", file: fakeFile("readme.txt") }, { name: "skip.exe" }],
      dirs: [
        {
          name: "第一章",
          files: [{ name: "a.docx", file: fakeFile("a.docx") }],
          dirs: [{ name: "附图", files: [{ name: "b.png", file: fakeFile("b.png") }], dirs: [] }],
        },
        { name: "空目录", files: [], dirs: [] },
      ],
    }
    const { folder, skipped } = flattenFolderNode(tree)
    assert.equal(folder.name, "产品手册")
    assert.deepEqual(
      folder.files.map((picked) => picked.relativePath),
      ["产品手册/readme.txt", "产品手册/第一章/a.docx", "产品手册/第一章/附图/b.png"],
    )
    assert.equal(skipped, 1)
  })
})

describe("folder-import target decisions", () => {
  it("sanitizes the folder name and falls back when empty", () => {
    assert.equal(sanitizeKnowledgeBaseName("  产品   手册  ", "导入 2026"), "产品 手册")
    assert.equal(sanitizeKnowledgeBaseName("   ", "导入 2026"), "导入 2026")
  })

  it("reuses an active base with the same name, ignoring case and padding", () => {
    const bases = [
      { id: "kb-1", name: "产品手册", status: "active" },
      { id: "kb-2", name: "归档库", status: "archived" },
    ]
    assert.equal(findReusableKnowledgeBase(bases, " 产品手册 ")?.id, "kb-1")
    assert.equal(findReusableKnowledgeBase(bases, "产品手册".toUpperCase())?.id, "kb-1")
    // An archived base with the same name must NOT be reused.
    assert.equal(findReusableKnowledgeBase(bases, "归档库"), null)
    assert.equal(findReusableKnowledgeBase(bases, "全新库"), null)
  })

  it("maps a file's category to its direct parent directory", () => {
    const root = "产品手册"
    assert.equal(categoryForPath("产品手册/readme.txt", root), "产品手册")
    assert.equal(categoryForPath("产品手册/第一章/a.docx", root), "第一章")
    assert.equal(categoryForPath("产品手册/第一章/附图/b.png", root), "附图")
    // Loose files (no folder prefix) land in the root-named category.
    assert.equal(categoryForPath("loose.pdf", root), "产品手册")
  })
})

describe("wave snapshots", () => {
  it("freezes target params and drops empty values", () => {
    assert.deepEqual(
      freezeWaveParams({ knowledgeBaseId: "kb-1", folder: "  ", parser: "", tags: [] }),
      { knowledgeBaseId: "kb-1" },
    )
    assert.deepEqual(
      freezeWaveParams({ knowledgeBaseId: "kb-1", folder: "新分类 ", parser: "marker", tags: ["a", "b"] }),
      { knowledgeBaseId: "kb-1", folder: "新分类", parser: "marker", tags: ["a", "b"] },
    )
  })
})

describe("duplicate pre-check", () => {
  it("matches by base name across case and directory separators", () => {
    const hits = matchExistingFileNames(
      ["docs/手册.PDF", "report.xlsx", "nested\\deep\\photo.jpg"],
      ["手册.pdf", "report.xlsx", "other.pdf", "photo.jpg"],
    )
    assert.equal(hits.size, 3)
    assert.equal(hits.has("手册.pdf"), true)
    assert.equal(hits.has("report.xlsx"), true)
    assert.equal(hits.has("photo.jpg"), true)
    assert.equal(hits.has("other.pdf"), false)
  })

  it("returns nothing when the target is empty", () => {
    assert.equal(matchExistingFileNames([], ["a.pdf"]).size, 0)
  })
})

describe("error copy mapping", () => {
  it("maps conflicts, profile mismatches and keeps generic messages", () => {
    // The backend's real 409 text (src/ingestion/lifecycle.ts).
    assert.equal(
      describeImportError("this source already exists with different content — specify an explicit intent: new_version or new_document").kind,
      "conflict",
    )
    assert.equal(describeImportError("HTTP 409: duplicate source").kind, "conflict")
    assert.equal(describeImportError("来源已存在").kind, "conflict")
    assert.equal(describeImportError("embedding profile mismatch").text, "知识库向量化配置与服务端不一致，无法导入")
    const generic = describeImportError("SSRF 拒绝访问")
    assert.equal(generic.kind, "generic")
    assert.equal(generic.text, "SSRF 拒绝访问")
  })
})

describe("active-count projection", () => {
  it("counts only rows that still owe an outcome", () => {
    const items = [
      { status: "queued" },
      { status: "uploading" },
      { status: "pending" },
      { status: "processing" },
      { status: "completed" },
      { status: "failed" },
      { status: "cancelled" },
    ]
    assert.equal(countActiveImports(items), 4)
    assert.equal(countActiveImports([]), 0)
  })
})

// ---------------------------------------------------------------------------
// UT-23: client admission, PDF-only parser params, retry gating.
// ---------------------------------------------------------------------------

const IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024

function fakePicked(name: string, size: number): { file: File; relativePath: string } {
  // Only name/size matter: the File body is never read here.
  const file = new File([], name)
  Object.defineProperty(file, "size", { value: size })
  return { file, relativePath: name }
}

describe("UT-23 client admission rows", () => {
  it("fails empty and oversize files with an admission kind; queues the rest", () => {
    const rows = buildImportRows(
      [
        fakePicked("empty.txt", 0),
        fakePicked("huge.pdf", IMPORT_MAX_FILE_BYTES + 1),
        fakePicked("ok.txt", 10),
      ],
      "wave-1",
      IMPORT_MAX_FILE_BYTES,
      (() => {
        let n = 0
        return () => `imp-${(n += 1)}`
      })(),
    )
    assert.equal(rows.length, 3)
    // Empty: rejected before upload with a stable, explainable kind.
    assert.equal(rows[0].status, "failed")
    assert.equal(rows[0].admissionKind, "empty_file")
    assert.match(rows[0].error ?? "", /空文件/)
    // Oversize: same — and the client did NOT relax the server's 20MB rule.
    assert.equal(rows[1].status, "failed")
    assert.equal(rows[1].admissionKind, "file_size")
    assert.match(rows[1].error ?? "", /20MB/)
    // Normal files still queue.
    assert.equal(rows[2].status, "queued")
    assert.equal(rows[2].admissionKind ?? null, null)
  })

  it("rejects one row without breaking the rest of the batch", () => {
    // A single rejected row is terminal for THAT row only: the queued rows
    // keep their file handles and flow into the upload workers unchanged.
    const rows = buildImportRows(
      [fakePicked("empty.txt", 0), fakePicked("a.pdf", 10), fakePicked("b.pdf", 10)],
      "wave-1",
      IMPORT_MAX_FILE_BYTES,
      () => "imp-x",
    )
    assert.equal(rows.filter((row) => row.status === "queued").length, 2)
    assert.equal(rows.filter((row) => row.status === "failed").length, 1)
    for (const row of rows.filter((row) => row.status === "queued")) {
      assert.ok(row.file, "queued rows keep their File handle")
    }
  })
})

describe("UT-23 retry gating", () => {
  const base = { status: "failed", sourceUrl: undefined as string | undefined }

  it("never offers upload retry for empty/oversize rows (无效重试)", () => {
    const gate = retryDecision({ ...base, file: new File([], "huge.pdf"), admissionKind: "file_size" })
    assert.equal(gate.retryable, false)
    assert.equal(gate.reason, "file_invalid")
    assert.equal(
      retryDecision({ ...base, file: new File([], "empty.txt"), admissionKind: "empty_file" }).retryable,
      false,
    )
  })

  it("does not dress re-upload up as same-document resume after acceptance", () => {
    // The server accepted this upload (docId exists): the failure happened in
    // PROCESSING. Re-uploading would create a NEW document — never shown as
    // resume (the resume command arrives with UT-27).
    const gate = retryDecision({ ...base, file: new File([], "a.pdf"), docId: "doc-1", errorKind: "server" })
    assert.equal(gate.retryable, false)
    assert.equal(gate.reason, "server_accepted")
  })

  it("offers re-upload for a transfer failure the server never received", () => {
    const gate = retryDecision({ ...base, file: new File([], "a.pdf"), docId: null, errorKind: "network" })
    assert.equal(gate.retryable, true)
    assert.equal(gate.reason ?? null, null)
  })

  it("keeps URL re-submission retryable on transient fetch failures", () => {
    const gate = retryDecision({ ...base, sourceUrl: "https://example.com/a" })
    assert.equal(gate.retryable, true)
  })

  it("ignores rows that are not failed", () => {
    assert.equal(retryDecision({ status: "queued", file: new File([], "a.pdf") }).retryable, false)
  })
})

describe("UT-23 server admission kind copy", () => {
  it("maps the structured admission kinds to explainable text", () => {
    assert.equal(describeImportError("空文件", { kind: "empty_file" }).text, "空文件无法导入：文件内容为 0 字节")
    assert.equal(describeImportError("HTTP 413: 文件超过 20MB 单文件上限", { kind: "file_size" }).kind, "admission")
    const conflict = describeImportError("HTTP 415: 文件类型与内容不符", { kind: "type_conflict", detected: "pdf" })
    assert.equal(conflict.kind, "admission")
    assert.match(conflict.text, /pdf/)
    assert.equal(describeImportError("HTTP 415: 不支持的文件类型", { kind: "unsupported_type" }).kind, "admission")
  })

  it("keeps the legacy conflict/profile/generic mapping when no kind rides along", () => {
    assert.equal(describeImportError("来源已存在").kind, "conflict")
    assert.equal(describeImportError("embedding profile mismatch").kind, "profile")
    assert.equal(describeImportError("SSRF 拒绝访问").text, "SSRF 拒绝访问")
  })

  it("appends the resume guard to task failures on accepted rows", () => {
    const view = describeImportError("嵌入服务不可用", { acceptedByServer: true })
    assert.equal(view.kind, "generic")
    assert.match(view.text, /已被服务端接收/)
    assert.match(view.text, /重新上传会创建新文档/)
    // The guard must NOT ride on admission/transfer failures (nothing accepted).
    assert.doesNotMatch(describeImportError("SSRF 拒绝访问").text, /已被服务端接收/)
  })
})

describe("UT-23 PDF-only parser override", () => {
  it("sends the override for PDF types and .pdf extensions only", () => {
    assert.equal(isPdfLike("手册.pdf", "application/pdf"), true)
    assert.equal(isPdfLike("手册.pdf", ""), true)
    assert.equal(isPdfLike("手册.PDF", ""), true)
  })

  it("withholds it from TXT and any type the client cannot confirm", () => {
    assert.equal(isPdfLike("notes.txt", "text/plain"), false)
    assert.equal(isPdfLike("data.csv", "text/csv"), false)
    // Unknown/octet-stream: the server decides — no PDF-only param rides.
    assert.equal(isPdfLike("mystery.bin", "application/octet-stream"), false)
    assert.equal(isPdfLike("noext", ""), false)
  })
})

describe("UT-24 wave pre-flight settlement", () => {
  const row = (id: string, waveId: string, extra: Partial<PrecheckSettleRow> = {}): PrecheckSettleRow => ({
    id, waveId, status: "queued", fileName: `${id}.pdf`, precheckSettled: false, ...extra,
  })

  it("settles only THIS wave's queued rows and marks the same-name hits", () => {
    const hits = new Set(["b.pdf"])
    const settled = settleWavePrecheck(
      [
        row("a", "wave-1"),
        row("b", "wave-1"),
        row("c", "wave-2"), // another wave's row: a stale callback must not touch it
        row("d", "wave-1", { status: "cancelled" }), // terminal rows stay terminal
        row("e", "wave-1", { precheckHit: false, precheckSettled: true }), // already settled
      ],
      "wave-1",
      hits,
    )
    const byId = new Map(settled.map((item) => [item.id, item]))
    assert.equal(byId.get("a")?.precheckSettled, true)
    assert.equal(byId.get("a")?.precheckHit ?? false, false)
    assert.equal(byId.get("b")?.precheckSettled, true)
    assert.equal(byId.get("b")?.precheckHit, true, "same-name hits wait for the user's decision")
    assert.equal(byId.get("c")?.precheckSettled, false, "other waves stay untouched")
    assert.equal(byId.get("d")?.status, "cancelled")
    assert.equal(byId.get("d")?.precheckSettled, false)
    assert.equal(byId.get("e")?.precheckSettled, true)
  })

  it("settles a wave cleanly when the pre-check itself failed (no hits at all)", () => {
    const settled = settleWavePrecheck([row("a", "wave-1"), row("b", "wave-2")], "wave-1", new Set())
    assert.equal(settled[0].precheckSettled, true)
    assert.equal(settled[0].precheckHit ?? false, false)
    assert.equal(settled[1].precheckSettled, false)
  })
})

describe("UT-32 invalid recovery entries", () => {
  const base = { status: "failed", sourceUrl: undefined as string | undefined }

  it("never offers upload retry for server-side permanent admission kinds", () => {
    // The server rejected THESE bytes by admission (structured 415/413 kinds):
    // the same bytes can never pass, so the retry entry would be invalid.
    for (const kind of ["type_conflict", "unsupported_type", "empty_file", "file_size"]) {
      const gate = retryDecision({ ...base, file: new File([], "a.pdf"), errorKind: kind })
      assert.equal(gate.retryable, false, kind)
      assert.equal(gate.reason, "file_invalid", kind)
    }
  })

  it("never offers upload retry for same-name conflict rows", () => {
    // A same-name conflict needs a user intent (查看文档 / replace) that a
    // blind re-upload cannot supply — the row keeps 查看文档, loses 重试.
    const gate = retryDecision({ ...base, file: new File([], "a.pdf"), errorKind: "conflict" })
    assert.equal(gate.retryable, false)
    assert.equal(gate.reason, "conflict")
  })

  it("keeps transport and unknown-server failures retryable", () => {
    // Regression guard: only PERMANENT classes lose the retry entry.
    for (const kind of ["network", "timeout", "server", "invalid_response"]) {
      assert.equal(
        retryDecision({ ...base, file: new File([], "a.pdf"), errorKind: kind }).retryable,
        true,
        kind,
      )
    }
  })

  it("classifies the server's 409 same-name body as a conflict", () => {
    assert.equal(
      serverUploadErrorKind(409, { error: "this source already exists", activeDocId: "doc-1" }),
      "conflict",
    )
    // 409 without the conflict marker is NOT a same-name conflict.
    assert.equal(serverUploadErrorKind(409, { error: "some other 409" }) ?? null, null)
    // Structured admission bodies ride their own kind elsewhere — not ours.
    assert.equal(serverUploadErrorKind(415, { error: { kind: "type_conflict" } }) ?? null, null)
    assert.equal(serverUploadErrorKind(500, { error: "boom", activeDocId: "doc-1" }) ?? null, null)
    assert.equal(serverUploadErrorKind(409, "not json") ?? null, null)
  })

  it("maps the conflict kind to the stable conflict view", () => {
    const view = describeImportError("this source already exists", { kind: "conflict" })
    assert.equal(view.kind, "conflict")
    assert.equal(view.text, "文档已存在或内容冲突")
  })
})

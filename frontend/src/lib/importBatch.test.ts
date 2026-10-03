import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  categoryForPath,
  countActiveImports,
  describeImportError,
  findReusableKnowledgeBase,
  flattenFolderNode,
  freezeWaveParams,
  isSupportedFileName,
  matchExistingFileNames,
  partitionLooseFiles,
  sanitizeKnowledgeBaseName,
  type FolderNode,
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

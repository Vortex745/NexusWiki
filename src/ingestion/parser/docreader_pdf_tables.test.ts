import assert from "node:assert/strict"
import test from "node:test"
import { DocReaderPdfParser } from "./docreader_pdf"
import type { ReadStreamResponse__Output } from "./docreader_types/docreader/ReadStreamResponse"

const PDF = Buffer.from("%PDF-1.7\n")

function parser(markdown: string): DocReaderPdfParser {
  return new DocReaderPdfParser({
    address: "fake-docreader",
    timeoutMs: 1_000,
    inputLimitBytes: 1024,
    outputLimitBytes: 1024 * 1024,
    clientFactory: () => ({
      async *readStream() {
        yield {
          meta: {
            markdown_content: markdown,
            image_dir_path: "",
            metadata: { page_count: "1" },
            error: "",
            image_count: 0,
            source_blocks: [{
              start: 0,
              end: Array.from(markdown).length,
              locator_json: '{"type":"pdf","page":1}',
            }],
          },
        } as ReadStreamResponse__Output
      },
      close() {},
    }),
  })
}

test("a final escaped pipe without a PDF table border stays in the final cell", async () => {
  const tableText = ["Field | Value", "--- | ---", String.raw`symbol | A\|`].join("\n")
  const doc = parser(["Before", "", tableText, "", "After"].join("\n"))

  const blocks = await doc.parse({ content: PDF, fileName: "table.pdf", documentId: "escaped-final-pipe" })

  assert.deepEqual(blocks.map((block) => [block.type, block.text]), [
    ["paragraph", "Before"],
    ["table", tableText],
    ["paragraph", "After"],
  ])
  assert.deepEqual(blocks[1].table, { headers: ["Field", "Value"], rows: [["symbol", "A|"]] })
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

test("an even backslash run leaves the final PDF table pipe as a border", async () => {
  // Two backslashes are literal content; the following pipe is unescaped.
  const tableText = ["Field | Value", "--- | ---", String.raw`symbol | A\\|`].join("\n")
  const doc = parser(tableText)

  const blocks = await doc.parse({ content: PDF, fileName: "parity.pdf", documentId: "even-final-pipe" })

  assert.deepEqual(blocks[0].table, { headers: ["Field", "Value"], rows: [["symbol", "A\\\\"]] })
  assert.equal(blocks[0].text, tableText)
})

test("an escaped final PDF table pipe followed by an explicit border creates no extra cell", async () => {
  const tableText = ["| Field | Value |", "| --- | --- |", String.raw`| symbol | A\| |`].join("\n")
  const doc = parser(tableText)

  const blocks = await doc.parse({ content: PDF, fileName: "border.pdf", documentId: "explicit-border" })

  assert.deepEqual(blocks[0].table, { headers: ["Field", "Value"], rows: [["symbol", "A|"]] })
  assert.equal(blocks[0].text, tableText)
})

test("trailing whitespace does not change PDF table escape or border meaning", async () => {
  const tableText = [
    "Field | Value",
    "--- | ---",
    String.raw`no-border | A\|` + "  \t",
    String.raw`border | A\| |` + "  \t",
    String.raw`even-border | A\\|` + "  \t",
    "plain-border | B |  \t",
  ].join("\n")
  const doc = parser(tableText)

  const blocks = await doc.parse({ content: PDF, fileName: "whitespace.pdf", documentId: "trailing-whitespace" })

  assert.deepEqual(blocks[0].table, {
    headers: ["Field", "Value"],
    rows: [["no-border", "A|"], ["border", "A|"], ["even-border", "A\\\\"], ["plain-border", "B"]],
  })
  assert.equal(blocks[0].text, tableText.trim())
})

test("interior PDF table pipes follow the same odd and even backslash rule as borders", async () => {
  const tableText = [
    "Field | Value | Tail",
    "--- | --- | ---",
    String.raw`odd-one | A\|B | C`,
    String.raw`even-two | A\\| B`,
    String.raw`odd-three | A\\\|B | C`,
    String.raw`even-four | A\\\\| B`,
    String.raw`\|leading | plain | C`,
  ].join("\n")
  const doc = parser(tableText)

  const blocks = await doc.parse({ content: PDF, fileName: "interior.pdf", documentId: "interior-pipes" })

  assert.deepEqual(blocks[0].table, {
    headers: ["Field", "Value", "Tail"],
    rows: [
      ["odd-one", "A|B", "C"],
      ["even-two", "A\\\\", "B"],
      ["odd-three", "A\\\\|B", "C"],
      ["even-four", "A\\\\\\\\", "B"],
      ["|leading", "plain", "C"],
    ],
  })
  assert.equal(blocks[0].text, tableText)
})

test("longer backslash runs preserve literal slashes while identifying final PDF table borders", async () => {
  // An odd run consumes just the pipe's escaping backslash; all others stay
  // literal. An even run leaves the pipe structural, preserving every slash.
  const tableText = [
    "Field | Value",
    "--- | ---",
    String.raw`odd-three | A\\\|`,
    String.raw`odd-three-bordered | A\\\||`,
    String.raw`even-four | A\\\\|`,
    String.raw`non-pipe | C:\temp\file`,
  ].join("\n")
  const doc = parser(tableText)

  const blocks = await doc.parse({ content: PDF, fileName: "slashes.pdf", documentId: "longer-slash-runs" })

  assert.deepEqual(blocks[0].table, {
    headers: ["Field", "Value"],
    rows: [
      ["odd-three", "A\\\\|"],
      ["odd-three-bordered", "A\\\\|"],
      ["even-four", "A\\\\\\\\"],
      ["non-pipe", "C:\\temp\\file"],
    ],
  })
  assert.equal(blocks[0].text, tableText)
})

for (const fixture of [
  {
    label: "bordered",
    markdown: "|  Field  |  Value  |\n| --- | --- |\n|  symbol  |  A  |\n| empty | |",
    rows: [["symbol", "A"], ["empty", ""]],
  },
  {
    label: "unbordered",
    markdown: "Field  |  Value\n--- | ---\n  symbol  |  A  \n next  | B",
    rows: [["symbol", "A"], ["next", "B"]],
  },
]) {
  test(`ordinary ${fixture.label} PDF tables retain headers, columns and whitespace trimming`, async () => {
    const doc = parser(fixture.markdown)

    const blocks = await doc.parse({ content: PDF, fileName: "ordinary.pdf", documentId: fixture.label })

    assert.deepEqual(blocks[0].table, { headers: ["Field", "Value"], rows: fixture.rows })
    assert.equal(blocks[0].text, fixture.markdown)
  })
}

test("structured escaped PDF table values retain their original raw extraction and surrounding prose", async () => {
  const tableText = ["Field | Value", "--- | ---", String.raw`symbol | A\|`].join("\n")
  const markdown = ["Before", "", tableText, "", "After"].join("\n")
  const doc = parser(markdown)

  const blocks = await doc.parse({ content: PDF, fileName: "raw.pdf", documentId: "raw-table" })
  const raw = await doc.parseRaw({ content: PDF, fileName: "raw.pdf" })

  assert.equal(JSON.parse(raw).markdown, markdown)
  assert.deepEqual(doc.normalizeRaw(raw, "raw-table"), blocks)
  assert.deepEqual(blocks.map((block) => block.text), ["Before", tableText, "After"])
  assert.deepEqual(blocks[1].table, { headers: ["Field", "Value"], rows: [["symbol", "A|"]] })
  assert.ok(blocks.every((block) => block.page === 1 && block.provenance.parser === "docreader-pdf"))
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

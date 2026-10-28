import { DocReaderPdfParser } from "./docreader_pdf"
import type { DocReaderRawEnvelope } from "./docreader_pdf_types"
import type { ReadStreamResponse__Output } from "./docreader_types/docreader/ReadStreamResponse"

export function createFakeDocReaderParser(
  markdown: string,
  sourceBlocks: DocReaderRawEnvelope["sourceBlocks"]
): DocReaderPdfParser {
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
            source_blocks: sourceBlocks.map((block) => ({
              start: block.start,
              end: block.end,
              locator_json: block.locatorJson,
            })),
          },
        } as ReadStreamResponse__Output
      },
      close() {},
    }),
  })
}

import assert from "node:assert/strict"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import * as grpc from "@grpc/grpc-js"
import * as protoLoader from "@grpc/proto-loader"
import {
  DocReaderClient,
  DocReaderError,
  builtinPdfEngine,
  type DocReaderGrpcClient,
  type DocReaderReadRequest,
} from "./docreader_client"

const PROTO = join(__dirname, "docreader.proto")

function packageDefinition() {
  return protoLoader.loadSync(PROTO, {
    keepCase: true,
    longs: String,
    enums: String,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
  })
}

async function startServer(handlers: grpc.UntypedServiceImplementation): Promise<{
  address: string
  server: grpc.Server
}> {
  const definition = grpc.loadPackageDefinition(packageDefinition()) as unknown as {
    docreader: { DocReader: { service: grpc.ServiceDefinition } }
  }
  const server = new grpc.Server()
  server.addService(definition.docreader.DocReader.service, handlers)
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error)
      else resolve(boundPort)
    })
  })
  server.start()
  return { address: `127.0.0.1:${port}`, server }
}

function request(overrides: Partial<DocReaderReadRequest> = {}): DocReaderReadRequest {
  return {
    fileContent: Buffer.from("%PDF-1.4"),
    fileName: "sample.pdf",
    fileType: "pdf",
    ...overrides,
  }
}

const metadata = {
  markdown_content: "# Heading\n\nBody",
  image_dir_path: "",
  metadata: { page_count: "1" },
  error: "",
  image_count: 1,
  source_blocks: [{ start: 0, end: 3, locator_json: '{"type":"pdf","page":1}' }],
}

test("ListEngines returns engine metadata and the builtin PDF helper recognizes it", async (t) => {
  const { address, server } = await startServer({
    ListEngines: (_call: unknown, callback: (error: Error | null, value: unknown) => void) => {
      callback(null, {
        engines: [
          {
            name: "builtin",
            description: "builtin parser",
            file_types: ["pdf", "docx"],
            available: true,
            unavailable_reason: "",
          },
        ],
      })
    },
  })
  const client = new DocReaderClient({ address, timeoutMs: 5_000 })
  t.after(() => {
    client.close()
    server.forceShutdown()
  })

  const engines = await client.listEngines()
  assert.equal(engines.length, 1)
  assert.equal(engines[0].name, "builtin")
  assert.deepEqual(engines[0].file_types, ["pdf", "docx"])
  assert.equal(builtinPdfEngine(engines)?.name, "builtin")
})

test("ReadStream yields the metadata frame before images and preserves order", async (t) => {
  const { address, server } = await startServer({
    ReadStream: (call: grpc.ServerWritableStream<unknown, unknown>) => {
      call.write({ meta: metadata })
      call.write({
        image: {
          filename: "images/sample_page_1.jpg",
          original_ref: "page-1",
          mime_type: "image/jpeg",
          storage_key: "",
          image_data: Buffer.from("first"),
        },
      })
      call.write({
        image: {
          filename: "images/sample_page_2.jpg",
          original_ref: "page-2",
          mime_type: "image/jpeg",
          storage_key: "",
          image_data: Buffer.from("second"),
        },
      })
      call.end()
    },
  })
  const client = new DocReaderClient({ address, timeoutMs: 5_000 })
  t.after(() => {
    client.close()
    server.forceShutdown()
  })

  const frames: Array<Record<string, unknown>> = []
  for await (const frame of client.readStream(request())) frames.push(frame as Record<string, unknown>)
  assert.equal(frames.length, 3)
  assert.equal((frames[0].meta as { markdown_content: string }).markdown_content, "# Heading\n\nBody")
  assert.equal((frames[1].image as { filename: string }).filename, "images/sample_page_1.jpg")
  assert.equal((frames[2].image as { filename: string }).filename, "images/sample_page_2.jpg")
})

test("ListEngines reports a deadline as a transient DocReaderError", async (t) => {
  const { address, server } = await startServer({
    ListEngines: () => {
      // Deliberately never callback: the client's deadline must terminate it.
    },
  })
  const client = new DocReaderClient({ address, timeoutMs: 5_000 })
  t.after(() => {
    client.close()
    server.forceShutdown()
  })

  await assert.rejects(
    client.listEngines(20),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.category, "transient")
      assert.equal(error.reasonCode, "docreader_deadline_exceeded")
      return true
    }
  )
})

test("ReadStream cancellation rejects with docreader_cancelled and stops the stream", async (t) => {
  const { address, server } = await startServer({
    ReadStream: (call: grpc.ServerWritableStream<unknown, unknown>) => {
      call.write({ meta: metadata })
      call.on("cancelled", () => call.end())
    },
  })
  const client = new DocReaderClient({ address, timeoutMs: 5_000 })
  t.after(() => {
    client.close()
    server.forceShutdown()
  })

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(
    (async () => {
      for await (const _frame of client.readStream(request(), { signal: controller.signal })) {
        // Drain the metadata frame, then wait for the abort.
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.category, "cancelled")
      assert.equal(error.reasonCode, "docreader_cancelled")
      return true
    }
  )
})

test("a broken stream rejects instead of ending silently", async () => {
  const transport = new PassThrough({ objectMode: true })
  const fake = {
    ReadStream: () => transport,
    ListEngines: () => { throw new Error("unused") },
    close: () => {},
  } as unknown as DocReaderGrpcClient
  const client = new DocReaderClient({ address: "fake", timeoutMs: 5_000, client: fake })
  const iterator = client.readStream(request())[Symbol.asyncIterator]()

  const first = iterator.next()
  transport.write({ meta: metadata })
  const metadataFrame = await first
  assert.equal((metadataFrame.value?.meta as { markdown_content: string }).markdown_content, "# Heading\n\nBody")

  const pending = iterator.next()
  transport.destroy(Object.assign(new Error("simulated stream break"), { code: grpc.status.UNKNOWN }))
  await assert.rejects(
    pending,
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_parse_failed")
      return true
    }
  )
  client.close()
})

test("an oversized frame maps to docreader_message_too_large", async (t) => {
  const { address, server } = await startServer({
    ReadStream: (call: grpc.ServerWritableStream<unknown, unknown>) => {
      call.write({ meta: metadata })
      call.write({
        image: {
          filename: "images/large.jpg",
          original_ref: "page-1",
          mime_type: "image/jpeg",
          storage_key: "",
          image_data: Buffer.alloc(4_096, 1),
        },
      })
      call.end()
    },
  })
  const client = new DocReaderClient({ address, timeoutMs: 5_000, maxMessageBytes: 1_024 })
  t.after(() => {
    client.close()
    server.forceShutdown()
  })

  let frames = 0
  await assert.rejects(
    (async () => {
      for await (const _frame of client.readStream(request())) frames += 1
    })(),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_message_too_large")
      return true
    }
  )
  assert.equal(frames, 1)
})

test("the client rejects empty addresses and non-positive timeouts", () => {
  assert.throws(() => new DocReaderClient({ address: "", timeoutMs: 1_000 }), /DOCREADER_ADDR/)
  assert.throws(() => new DocReaderClient({ address: "127.0.0.1:1", timeoutMs: 0 }), /DOCREADER_TIMEOUT_MS/)
})

test("an early consumer exit cancels the stream without an unhandled error", async (t) => {
  const { address, server } = await startServer({
    ReadStream: (call: grpc.ServerWritableStream<unknown, unknown>) => {
      call.write({ meta: { ...metadata, error: "terminal" } })
      // Deliberately never end: the consumer throws on meta.error and exits.
    },
  })
  const client = new DocReaderClient({ address, timeoutMs: 5_000 })
  t.after(() => {
    client.close()
    server.forceShutdown()
  })
  const iterator = client.readStream(request())[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal((first.value?.meta as { error: string }).error, "terminal")
  await iterator.return(undefined)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(true, "no unhandled cancellation error")
})

import { join } from "node:path"
import * as grpc from "@grpc/grpc-js"
import * as protoLoader from "@grpc/proto-loader"
import type { IngestionFailureCategory } from "../error_classification"
import type { ProtoGrpcType } from "./docreader_types/docreader"
import type { ReadRequest } from "./docreader_types/docreader/ReadRequest"
import type { ReadStreamResponse__Output } from "./docreader_types/docreader/ReadStreamResponse"
import type { ListEnginesResponse__Output } from "./docreader_types/docreader/ListEnginesResponse"
import type { ParserEngineInfo__Output } from "./docreader_types/docreader/ParserEngineInfo"

export const DOCREADER_MAX_MESSAGE_BYTES = 32 * 1024 * 1024
export const DOCREADER_PROBE_TIMEOUT_MS = 3_000
export const DOCREADER_BUILTIN_ENGINE = "builtin"

/** Stable, non-secret failure codes for the ingestion classifier and operators. */
export type DocReaderFailureCode =
  | "docreader_unavailable"
  | "docreader_deadline_exceeded"
  | "docreader_capability_missing"
  | "docreader_message_too_large"
  | "docreader_invalid_request"
  | "docreader_parse_failed"
  | "docreader_cancelled"
  | "docreader_invalid_stream"
  | "docreader_image_missing"
  | "docreader_ocr_required"
  | "docreader_no_extractable_text"

export class DocReaderError extends Error {
  constructor(
    message: string,
    readonly category: IngestionFailureCategory,
    readonly reasonCode: DocReaderFailureCode,
    readonly grpcStatus?: number
  ) {
    super(message)
    this.name = "DocReaderError"
  }
}

export interface DocReaderReadRequest {
  fileContent: Buffer
  fileName: string
  fileType?: string
  title?: string
  requestId?: string
  parserEngine?: string
  parserEngineOverrides?: Record<string, string>
}

export interface DocReaderClientOptions {
  address: string
  timeoutMs: number
  maxMessageBytes?: number
  credentials?: grpc.ChannelCredentials
  channelOptions?: grpc.ChannelOptions
  /** Test seam: point at a vendored proto without changing production paths. */
  protoPath?: string
  /** Test seam: a pre-built client (for example, a fake transport). */
  client?: DocReaderGrpcClient
}

export interface DocReaderGrpcClient extends grpc.Client {
  ListEngines(
    argument: { config_overrides?: Record<string, string> },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ListEnginesResponse__Output>
  ): grpc.ClientUnaryCall
  ReadStream(
    argument: ReadRequest,
    metadata: grpc.Metadata,
    options?: grpc.CallOptions
  ): grpc.ClientReadableStream<ReadStreamResponse__Output>
}

export interface DocReaderStreamOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

let cachedProto: ProtoGrpcType | null = null

function loadDocReaderProto(protoPath: string): ProtoGrpcType {
  if (cachedProto) return cachedProto
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
    includeDirs: [join(__dirname)],
  })
  cachedProto = grpc.loadPackageDefinition(definition) as unknown as ProtoGrpcType
  return cachedProto
}

function mapGrpcError(error: unknown): DocReaderError {
  if (error instanceof DocReaderError) return error
  const status = typeof (error as { code?: unknown })?.code === "number"
    ? (error as { code: number }).code
    : undefined
  const detail = error instanceof Error ? error.message : String(error)
  switch (status) {
    case grpc.status.CANCELLED:
      return new DocReaderError("DocReader request was cancelled", "cancelled", "docreader_cancelled", status)
    case grpc.status.UNIMPLEMENTED:
      return new DocReaderError(
        "DocReader does not implement the requested method",
        "capability_missing",
        "docreader_capability_missing",
        status
      )
    case grpc.status.UNAVAILABLE:
      return new DocReaderError(
        "DocReader service is unavailable",
        "transient",
        "docreader_unavailable",
        status
      )
    case grpc.status.DEADLINE_EXCEEDED:
      return new DocReaderError(
        "DocReader request exceeded its deadline",
        "transient",
        "docreader_deadline_exceeded",
        status
      )
    case grpc.status.RESOURCE_EXHAUSTED:
      return new DocReaderError(
        "DocReader response exceeded the configured message limit",
        "permanent_input",
        "docreader_message_too_large",
        status
      )
    case grpc.status.INVALID_ARGUMENT:
      return new DocReaderError(
        "DocReader rejected the request as invalid",
        "permanent_input",
        "docreader_invalid_request",
        status
      )
    default:
      return new DocReaderError(
        `DocReader failed: ${detail}`,
        "permanent_input",
        "docreader_parse_failed",
        status
      )
  }
}

function toProtoRequest(request: DocReaderReadRequest): ReadRequest {
  return {
    file_content: request.fileContent,
    file_name: request.fileName,
    file_type: request.fileType ?? "",
    title: request.title ?? "",
    request_id: request.requestId ?? "",
    config: {
      parser_engine: request.parserEngine ?? "",
      parser_engine_overrides: request.parserEngineOverrides ?? {},
    },
  }
}

export class DocReaderClient {
  private readonly client: DocReaderGrpcClient
  private readonly timeoutMs: number
  private closed = false

  constructor(options: DocReaderClientOptions) {
    if (!options.address.trim()) throw new Error("DOCREADER_ADDR must not be empty")
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("DOCREADER_TIMEOUT_MS must be a positive integer")
    }
    this.timeoutMs = options.timeoutMs
    if (options.client) {
      this.client = options.client
      return
    }
    const proto = loadDocReaderProto(options.protoPath ?? join(__dirname, "docreader.proto"))
    const Service = proto.docreader.DocReader
    const maxMessageBytes = options.maxMessageBytes ?? DOCREADER_MAX_MESSAGE_BYTES
    const channelOptions: grpc.ChannelOptions = {
      "grpc.max_receive_message_length": maxMessageBytes,
      "grpc.max_send_message_length": maxMessageBytes,
      ...options.channelOptions,
    }
    this.client = new Service(
      options.address,
      options.credentials ?? grpc.credentials.createInsecure(),
      channelOptions
    ) as unknown as DocReaderGrpcClient
  }

  async listEngines(timeoutMs = DOCREADER_PROBE_TIMEOUT_MS): Promise<ParserEngineInfo__Output[]> {
    if (this.closed) throw new DocReaderError("DocReader client is closed", "capability_missing", "docreader_capability_missing")
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("DocReader ListEngines timeout must be positive")
    }
    return await new Promise<ParserEngineInfo__Output[]>((resolve, reject) => {
      this.client.ListEngines(
        { config_overrides: {} },
        new grpc.Metadata(),
        { deadline: Date.now() + timeoutMs },
        (error, response) => {
          if (error) {
            reject(mapGrpcError(error))
            return
          }
          if (!response || !Array.isArray(response.engines)) {
            reject(new DocReaderError(
              "DocReader ListEngines returned an invalid response",
              "permanent_input",
              "docreader_parse_failed"
            ))
            return
          }
          resolve(response.engines)
        }
      )
    })
  }

  async *readStream(
    request: DocReaderReadRequest,
    options: DocReaderStreamOptions = {}
  ): AsyncGenerator<ReadStreamResponse__Output> {
    if (this.closed) throw new DocReaderError("DocReader client is closed", "capability_missing", "docreader_capability_missing")
    if (options.signal?.aborted) {
      throw new DocReaderError("DocReader read was cancelled", "cancelled", "docreader_cancelled")
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("DocReader read timeout must be positive")
    }
    const call = this.client.ReadStream(toProtoRequest(request), new grpc.Metadata(), {
      deadline: Date.now() + timeoutMs,
    })

    type Item =
      | { kind: "frame"; frame: ReadStreamResponse__Output }
      | { kind: "error"; error: DocReaderError }
      | { kind: "end" }
    const queue: Item[] = []
    let pending: ((item: Item) => void) | null = null
    let settled = false

    const push = (item: Item): void => {
      if (settled) return
      if (item.kind !== "frame") settled = true
      if (pending) {
        const resolve = pending
        pending = null
        resolve(item)
      } else {
        queue.push(item)
      }
    }
    const onData = (frame: ReadStreamResponse__Output): void => push({ kind: "frame", frame })
    const onError = (error: Error): void => push({ kind: "error", error: mapGrpcError(error) })
    const onEnd = (): void => push({ kind: "end" })
    const onAbort = (): void => {
      call.cancel()
      push({
        kind: "error",
        error: new DocReaderError("DocReader read was cancelled", "cancelled", "docreader_cancelled"),
      })
    }

    call.on("data", onData)
    call.on("error", onError)
    call.on("end", onEnd)
    options.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      while (true) {
        const item = queue.length > 0
          ? queue.shift()!
          : await new Promise<Item>((resolve) => { pending = resolve })
        if (item.kind === "end") return
        if (item.kind === "error") throw item.error
        yield item.frame
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort)
      call.removeListener("data", onData)
      call.removeListener("error", onError)
      call.removeListener("end", onEnd)
      if (!settled) call.cancel()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.client.close()
  }
}

export function builtinPdfEngine(engines: readonly ParserEngineInfo__Output[]): ParserEngineInfo__Output | null {
  return engines.find(
    (engine) => engine.name === DOCREADER_BUILTIN_ENGINE && engine.file_types.includes("pdf")
  ) ?? null
}

import { DocReaderClient, builtinPdfEngine } from "../src/ingestion/parser/docreader_client"

async function main(): Promise<void> {
  const address = process.env.DOCREADER_ADDR?.trim() || "127.0.0.1:50051"
  const timeoutMs = Number(process.env.DOCREADER_TIMEOUT_MS) || 300_000
  const client = new DocReaderClient({ address, timeoutMs })
  try {
    const engines = await client.listEngines(3_000)
    const builtin = builtinPdfEngine(engines)
    const result = {
      address,
      engines: engines.map((engine) => ({
        name: engine.name,
        file_types: engine.file_types,
        available: engine.available,
        unavailable_reason: engine.unavailable_reason,
      })),
      builtinPdf: builtin
        ? { available: builtin.available, unavailable_reason: builtin.unavailable_reason }
        : null,
    }
    console.log(JSON.stringify(result, null, 2))
    if (!builtin || !builtin.available) {
      console.error("DocReader builtin PDF engine is unavailable")
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    client.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

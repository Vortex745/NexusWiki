const { copyFileSync, mkdirSync } = require("node:fs")
const { join } = require("node:path")

const source = join(__dirname, "..", "src", "ingestion", "parser", "docreader.proto")
const targetDirectory = join(__dirname, "..", "dist", "ingestion", "parser")
mkdirSync(targetDirectory, { recursive: true })
copyFileSync(source, join(targetDirectory, "docreader.proto"))

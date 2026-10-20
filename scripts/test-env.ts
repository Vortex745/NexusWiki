/**
 * Test bootstrap: promote the PARSER COMMANDS from `.env` into the test
 * process, and nothing else.
 *
 * Why only these: `src/index.ts` loads the whole `.env` at process start, but
 * `loadConfig()` is pure and the test runner never imports the entry point.
 * Parser commands are machine-specific paths (a Python with PyMuPDF, marker,
 * mineru), so without this the suite silently falls back to `python` on PATH
 * and every PDF test fails with "PyMuPDF is required".
 *
 * Deliberately NOT loaded: credentials, DEMO_OIDC, EMBEDDING_*, SQLITE_PATH.
 * Those change behaviour tests are supposed to pin, and an ambient `.env`
 * must not decide whether a test runs the single-tenant or enforced path.
 *
 * Ambient environment always wins: a variable already set is left untouched.
 */
import { readFileSync } from "node:fs"
import { parse } from "dotenv"

const PARSER_COMMAND_KEYS = [
  "PYTHON_COMMAND",
  "MARKITDOWN_COMMAND",
  "MARKER_COMMAND",
  "MINERU_COMMAND",
] as const

try {
  const parsed = parse(readFileSync(".env"))
  for (const key of PARSER_COMMAND_KEYS) {
    const value = parsed[key]
    if (value && !process.env[key]) process.env[key] = value
  }
} catch {
  // No `.env` (CI, fresh clone): ambient environment is the only source.
}

/**
 * Retro-guardrails T2 (2026-10-05): steering-file navigation pointers are
 * contracts too — they rot silently (the previous pointer to the ticket
 * state lived only in a deleted evidence file). Assert the pointers an
 * agent session depends on at startup, the same way
 * src/release/dormant_surface_audit.test.ts asserts its navigation targets.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(__dirname, "..")

const hints = () => readFileSync(join(root, "HINTS.md"), "utf8")
const agents = () => readFileSync(join(root, "AGENTS.md"), "utf8")

test("HINTS.md explains that src/frontend/ is the @core shared core", () => {
  assert.match(
    hints(),
    /`src\/frontend\/` is the `@core` shared conversation core/,
    "agents otherwise re-suspect src/frontend/ as a stale frontend copy on every session",
  )
})

test("HINTS.md points at the live ticket state", () => {
  assert.match(
    hints(),
    /\.scratch\/upload-integrity-tickets\/README\.md/,
    "the UT-series execution entry must be reachable from the startup file",
  )
})

test("HINTS.md points at the contract-assertion test files", () => {
  assert.match(
    hints(),
    /src\/frontend\/app\.contract\.test\.ts/,
    "dependency contracts live here — auditors must check before removing deps",
  )
  assert.match(
    hints(),
    /src\/release\/dormant_surface_audit\.test\.ts/,
    "dormant-surface policy lives here — auditors must check before deleting modules",
  )
})

test("HINTS.md documents the push gate and how to arm it", () => {
  const content = hints()
  assert.match(content, /githooks\/pre-push/, "the push gate must be discoverable")
  assert.match(
    content,
    /git config core\.hooksPath githooks/,
    "a fresh clone must be able to arm the gate from the doc alone",
  )
})

test("AGENTS.md is navigation-only and carries no decommissioned tooling", () => {
  const content = agents()
  assert.doesNotMatch(
    content,
    /code-review-graph/,
    "the graph MCP was decommissioned (server config removed) — references here are sediment",
  )
  assert.match(content, /HINTS\.md/, "AGENTS.md must route sessions to HINTS.md")
  assert.match(
    content,
    /dormant_surface_audit/,
    "AGENTS.md must warn about the dormant-surface guard before anything gets deleted",
  )
})

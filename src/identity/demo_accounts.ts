/**
 * Ticket 01 (IAM-01): the three local demo identities.
 *
 * The demo signs in as one of three fixed accounts. Each account is a
 * server-side preset — the client only ever sends an account key and a
 * password, never claims, groups or scopes. The issuer therefore cannot be
 * asked to mint an identity it does not already know about.
 *
 * Scopes are the authorization axis the access middleware enforces; groups
 * are the isolation axis later knowledge-scope tickets build on. Readers get
 * `chat` only, so every admin-gated route rejects them without a second
 * check.
 */

import type { Scope } from "../access/context"

export type DemoAccountKey = "admin" | "technical-reader" | "policy-reader"

export interface DemoAccount {
  key: DemoAccountKey
  /** Human label shown on the sign-in screen. */
  label: string
  subjectId: string
  groups: string[]
  scopes: Scope[]
}

/** Every demo identity belongs to one tenant; groups separate the readers. */
export const DEMO_TENANT_ID = "demo"

export const DEMO_ADMIN_GROUP = "demo-admins"
export const DEMO_TECHNICAL_READER_GROUP = "demo-technical-readers"
export const DEMO_POLICY_READER_GROUP = "demo-policy-readers"

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: "admin",
    label: "管理员",
    subjectId: "demo-admin",
    groups: [DEMO_ADMIN_GROUP],
    scopes: ["chat", "ingest", "review", "admin"],
  },
  {
    key: "technical-reader",
    label: "技术读者",
    subjectId: "demo-technical-reader",
    groups: [DEMO_TECHNICAL_READER_GROUP],
    scopes: ["chat"],
  },
  {
    key: "policy-reader",
    label: "政策读者",
    subjectId: "demo-policy-reader",
    groups: [DEMO_POLICY_READER_GROUP],
    scopes: ["chat"],
  },
]

/** Resolve an account key to its preset. Unknown keys return null. */
export function resolveDemoAccount(key: unknown): DemoAccount | null {
  if (typeof key !== "string") return null
  return DEMO_ACCOUNTS.find((account) => account.key === key) ?? null
}

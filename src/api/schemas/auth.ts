import { z } from "zod"

/**
 * Boundary parsers. They guarantee a JSON object before the credential
 * authority sees it; the domain rules (ID shape, password length) stay in
 * one place and keep their specific error codes.
 */
export const requestObjectSchema = z.record(z.string(), z.unknown())

export const adminUsersQuerySchema = z.object({
  q: z.string().optional().default(""),
  status: z.enum(["all", "active", "disabled"]).optional().default("all"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
})

import { z } from "zod"

export const adminSearchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["all", "active", "disabled"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
})

export type AdminSearch = z.infer<typeof adminSearchSchema>

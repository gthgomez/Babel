import { z } from 'zod'

export const RESEARCH_STORE_CONTROL_FILE = 'research-store.session.json'

export const StoreControlRecordSchema = z
  .object({
    schema_version: z.literal(1),
    session_id: z.string().min(1),
    pid: z.number().int().positive(),
    opened_at: z.string().min(1),
    release_token: z.string().min(1),
  })
  .strict()

export type StoreControlRecord = z.infer<typeof StoreControlRecordSchema>

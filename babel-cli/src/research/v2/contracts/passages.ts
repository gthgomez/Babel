import { z } from 'zod'
import { ContentHashSchema, RecordIdSchema } from './common.js'

export const PassageLocatorSchema = z
  .object({
    kind: z.enum(['line_range', 'section', 'page', 'table_cell', 'byte_offset']),
    start: z.union([z.number().int().nonnegative(), z.string().min(1)]),
    end: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
    label: z.string().optional(),
  })
  .strict()

export const PassageTextRefSchema = z
  .object({
    mode: z.enum(['inline', 'blob_ref']),
    /** Bounded inline text when mode is inline. */
    text: z.string().max(32_000).optional(),
    blob_ref: z.string().min(1).optional(),
    text_hash: ContentHashSchema,
  })
  .strict()

export const PassageRecordSchema = z
  .object({
    passage_id: RecordIdSchema,
    source_revision_id: RecordIdSchema,
    locator: PassageLocatorSchema,
    text_ref: PassageTextRefSchema,
    heading_path: z.array(z.string()).optional(),
    extraction_notes: z.array(z.string()).optional(),
  })
  .strict()

export type PassageRecord = z.infer<typeof PassageRecordSchema>

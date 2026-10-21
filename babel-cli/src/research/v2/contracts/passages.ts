import { z } from 'zod'
import { ContentHashSchema, RecordIdSchema } from './common.js'

const positiveInt = z.number().int().positive()

export const PassageLocatorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('line_range'),
      start_line: positiveInt,
      end_line: positiveInt,
    })
    .strict()
    .refine((v) => v.end_line >= v.start_line, { message: 'inverted line range' }),
  z
    .object({
      kind: z.literal('page'),
      start_page: positiveInt,
      end_page: positiveInt.optional(),
    })
    .strict()
    .refine((v) => v.end_page === undefined || v.end_page >= v.start_page, {
      message: 'inverted page range',
    }),
  z.object({ kind: z.literal('section'), section_id: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('table_cell'),
      table_id: z.string().min(1),
      row: positiveInt,
      column: positiveInt,
    })
    .strict(),
  z
    .object({
      kind: z.literal('byte_offset'),
      start_offset: z.number().int().nonnegative(),
      end_offset: z.number().int().nonnegative(),
    })
    .strict()
    .refine((v) => v.end_offset >= v.start_offset, { message: 'inverted byte range' }),
])

export const PassageTextRefSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('inline'),
      text: z.string().min(1).max(32_000),
      text_hash: ContentHashSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('blob_ref'),
      blob_ref: z.string().min(1),
      text_hash: ContentHashSchema,
    })
    .strict(),
])

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

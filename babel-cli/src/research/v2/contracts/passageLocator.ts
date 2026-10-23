import { z } from 'zod'

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

export type PassageLocator = z.infer<typeof PassageLocatorSchema>

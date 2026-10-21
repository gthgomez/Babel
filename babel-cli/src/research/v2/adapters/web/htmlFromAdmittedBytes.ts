import { createHash } from 'node:crypto'
import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { decodeAdmittedUtf8Bytes } from '../documents/plainTextFromAdmittedBytes.js'

export const HTML_MEDIA_TYPE = 'text/html'
export const STATIC_HTML_EXTRACTION_VERSION = 'general-static-html/0.1.0'

function passageTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sectionIdFromHeading(heading: string): string {
  const slug = heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug.length > 0 ? slug : 'section'
}

/** Minimal static HTML: one passage per heading block (offline fixtures only; no JS). */
export function passagesFromAdmittedStaticHtml(admitted: AdmittedContent): PassageRecord[] {
  if (admitted.media_type !== HTML_MEDIA_TYPE) {
    throw new Error(
      `unsupported media_type for static HTML extractor: ${admitted.media_type} (only ${HTML_MEDIA_TYPE})`,
    )
  }
  const raw = decodeAdmittedUtf8Bytes(admitted)
  const html = raw.toString('utf8')
  if (/<form[^>]*>[\s\S]*password/i.test(html) && !/<h[1-6]/i.test(html)) {
    throw new Error('html appears to be login-only markup; extraction incomplete')
  }
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
  const headingRe = /<h([1-6])[^>]*>([^<]*)<\/h[1-6]>/gi
  const passages: PassageRecord[] = []
  let match: RegExpExecArray | null
  let index = 0
  while ((match = headingRe.exec(stripped)) !== null) {
    const heading = (match[2] ?? '').trim()
    if (!heading) continue
    const level = Number(match[1] ?? '1')
    const after = stripped.slice(match.index + match[0].length)
    const nextHeading = after.search(/<h[1-6]/i)
    const block = nextHeading >= 0 ? after.slice(0, nextHeading) : after
    const text = block
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    const sectionId = sectionIdFromHeading(heading)
    const record: PassageRecord = {
      passage_id: `${admitted.operation_id}:html:${index++}`,
      source_revision_id: admitted.revision.revision_id,
      locator: { kind: 'section', section_id: sectionId },
      heading_path: [heading],
      text_ref: {
        mode: 'inline',
        text: text.length > 32_000 ? text.slice(0, 32_000) : text,
        text_hash: passageTextHash(text),
      },
      extraction_notes: [`heading_level:${level}`, 'static_html_offline'],
    }
    PassageRecordSchema.parse(record)
    passages.push(record)
  }
  if (passages.length === 0) {
    throw new Error('no heading-bounded sections extracted from admitted HTML')
  }
  return passages
}

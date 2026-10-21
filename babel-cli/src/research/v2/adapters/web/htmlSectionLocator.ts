import { createHash } from 'node:crypto'

export function sectionSlugFromHeading(heading: string): string {
  const trimmed = heading.trim()
  const ascii = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (ascii.length > 0) return ascii.slice(0, 80)
  const digest = createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 16)
  return `heading-${digest}`
}

/** Deterministic section_id unique within one extraction pass (repeated headings disambiguated). */
export function allocateSectionLocatorId(
  heading: string,
  occurrenceBySlug: Map<string, number>,
): string {
  const slug = sectionSlugFromHeading(heading)
  const seen = occurrenceBySlug.get(slug) ?? 0
  occurrenceBySlug.set(slug, seen + 1)
  if (seen === 0) return slug
  return `${slug}~${seen + 1}`
}

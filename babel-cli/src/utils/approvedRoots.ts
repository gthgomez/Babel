import { existsSync } from 'node:fs'

/**
 * Split an approved-roots environment value into individual paths.
 *
 * The documented formats differ by variable (`;` for
 * BABEL_OPENCLAW_APPROVED_ROOTS, `,` for BABEL_ALLOWED_ROOTS), and older code
 * split one of them with the wrong separator. An absolute path under an
 * approved root was then silently absent from the parsed list. Accept both
 * separators plus newlines for every approved-roots value.
 *
 * A value that names one existing path is returned verbatim even if that path
 * contains a separator character, which is legal on POSIX filesystems.
 */
export function splitApprovedRoots(raw: string | null | undefined): string[] {
  const trimmed = raw?.trim()
  if (!trimmed) return []
  if (existsSync(trimmed)) return [trimmed]
  return [...new Set(
    trimmed
      .split(/[;,\n]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )]
}

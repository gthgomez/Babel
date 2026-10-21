import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERBATIM_BRIEF_CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
)

export type VerbatimBriefCaseId =
  | 'G-DEV-01'
  | 'G-DEV-02'
  | 'G-DEV-03'
  | 'G-DEV-04'
  | 'G-DEV-05'
  | 'G-DEV-06'

export interface VerbatimBriefFixtureManifest {
  cases: Record<
    VerbatimBriefCaseId,
    { sha256: string; byte_length: number; crlf_mis_checkout_sha256: string }
  >
}

export function loadVerbatimBriefManifest(): VerbatimBriefFixtureManifest {
  return JSON.parse(
    readFileSync(join(VERBATIM_BRIEF_CORPUS_DIR, 'BRIEF_FIXTURE_MANIFEST.json'), 'utf8'),
  ) as VerbatimBriefFixtureManifest
}

/** Locked LF bytes for Agent B mission.json fixtures (see corpus .gitattributes). */
export function readVerbatimBriefBytes(caseId: VerbatimBriefCaseId): Buffer {
  const manifest = loadVerbatimBriefManifest()
  const spec = manifest.cases[caseId]
  const bytes = readFileSync(join(VERBATIM_BRIEF_CORPUS_DIR, caseId, 'mission.json'))
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== spec.byte_length) {
    throw new Error(
      `${caseId} mission.json byte_length ${bytes.length} !== locked ${spec.byte_length} (check git eol=lf checkout)`,
    )
  }
  if (sha !== spec.sha256) {
    if (sha === spec.crlf_mis_checkout_sha256) {
      throw new Error(
        `${caseId} mission.json has CRLF mis-checkout hash ${sha}; expected LF ${spec.sha256}`,
      )
    }
    throw new Error(`${caseId} mission.json bytes changed from B original`)
  }
  return bytes
}

export function parseVerbatimBriefJson(caseId: VerbatimBriefCaseId): unknown {
  return JSON.parse(readVerbatimBriefBytes(caseId).toString('utf8'))
}

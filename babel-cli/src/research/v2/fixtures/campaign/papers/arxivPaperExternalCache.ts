import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import arxivManifest from './1706.03762.manifest.json' with { type: 'json' }

export type ArxivPaperCacheResolveResult =
  | {
      status: 'ok'
      bytes: Buffer
      resolvedPath: string
      contentSha256: string
    }
  | {
      status: 'missing'
      expectedPath: string
      manifestSha256: string
      manifestByteLength: number
    }
  | {
      status: 'digest_mismatch'
      resolvedPath: string
      manifestSha256: string
      actualSha256: string
    }

function defaultCachePath(): string {
  const override = process.env.BABEL_RESEARCH_V2_CAMPAIGN_PAPER_CACHE?.trim()
  if (override) {
    return join(override, arxivManifest.artifact_path)
  }
  return join(homedir(), '.cache', 'babel', 'research-v2', 'campaign', 'papers', arxivManifest.artifact_path)
}

/** Opt-in: arXiv full-paper bytes are not tracked in Git; verify with BABEL_RESEARCH_V2_VERIFY_ARXIV_PAPER_CACHE=1. */
export function resolveArxiv170603762PaperBytesFromExternalCache(): ArxivPaperCacheResolveResult {
  const expectedPath = defaultCachePath()
  if (!existsSync(expectedPath)) {
    return {
      status: 'missing',
      expectedPath,
      manifestSha256: arxivManifest.content_sha256,
      manifestByteLength: arxivManifest.byte_length,
    }
  }
  const bytes = readFileSync(expectedPath)
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (actualSha256 !== arxivManifest.content_sha256) {
    return {
      status: 'digest_mismatch',
      resolvedPath: expectedPath,
      manifestSha256: arxivManifest.content_sha256,
      actualSha256,
    }
  }
  return {
    status: 'ok',
    bytes,
    resolvedPath: expectedPath,
    contentSha256: actualSha256,
  }
}

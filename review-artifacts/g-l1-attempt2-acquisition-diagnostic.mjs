#!/usr/bin/env node
/**
 * Bounded acquisition replay for G-L1 attempt2 (no model, no store mutation).
 * Provenance: ec7dce91 production search + admittedHttpGet + same discover query as live run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const babelCli = join(repoRoot, 'codex/worktrees/ec7dce91/babel-cli')

const { ResearchMissionV2Schema } = await import(
  join(babelCli, 'src/research/v2/contracts/mission.ts')
)
const { createMissionProductionSearchProvider } = await import(
  join(babelCli, 'src/research/v2/access/createMissionProductionSearchProvider.ts')
)
const { createGovernedSourceAccessPort } = await import(
  join(babelCli, 'src/research/v2/access/governedSourceAccessPort.ts')
)
const { GeneralWebAdapter } = await import(
  join(babelCli, 'src/research/v2/adapters/web/generalWebAdapter.ts')
)
const { admittedHttpGet } = await import(join(babelCli, 'src/research/v2/access/admittedHttpGet.ts'))
const { validateMissionWebHopUrl } = await import(
  join(babelCli, 'src/research/v2/access/missionSourceAdmission.ts')
)

const missionPath = join(repoRoot, 'codex/missions/general-g-l1-python-stable-attempt2/mission.json')
const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
const discoverQuery = 'latest stable Python release python.org download'
const signal = new AbortController().signal

const searchProvider = createMissionProductionSearchProvider({ mission })
const access = createGovernedSourceAccessPort({ mission, searchProvider })
const adapter = new GeneralWebAdapter()

const discover = await adapter.discover(
  { operationId: 'diag-discover', query: discoverQuery, signal },
  access,
)

function classifyMagic(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip_magic_1f8b'
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf_magic'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16_le_bom'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16_be_bom'
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8_bom'
  return 'none'
}

function utf8FailureOffset(buf) {
  const dec = new TextDecoder('utf-8', { fatal: true })
  for (let end = 1; end <= buf.length; end += 1) {
    try {
      dec.decode(buf.subarray(0, end))
    } catch {
      return end - 1
    }
  }
  return null
}

const candidates =
  discover.status === 'ok'
    ? discover.candidates.map((s, i) => ({
        index: i,
        source_id: s.source_id,
        canonical_key: s.canonical_key,
        observed_url: s.observed_urls[0] ?? null,
        title: s.title ?? null,
      }))
    : []

let fetchDiag = null
if (discover.status === 'ok' && discover.candidates[0]) {
  const source = discover.candidates[0]
  const requestedUrl = source.observed_urls[0]
  const hopAssert = (hopUrl) => {
    const v = validateMissionWebHopUrl(hopUrl.href, source, mission)
    if (v) throw new Error(v)
  }
  const http = await admittedHttpGet({
    url: requestedUrl,
    maxBytes: 200_000,
    signal,
    assertHopAdmitted: hopAssert,
  })
  const buf = http.buffer
  const contentEncoding = http.contentType // note: admittedHttpGet returns contentType from header only
  fetchDiag = {
    requested_url: http.requestedUrl,
    final_url: http.finalUrl,
    redirect_chain: http.redirectChain,
    http_status: http.status,
    ok: http.ok,
    content_type_header: http.contentType,
    bytes_received: http.bytesReceived,
    buffered_length: buf.length,
    truncated: http.truncated,
    sha256: createHash('sha256').update(buf).digest('hex'),
    magic: classifyMagic(buf),
    utf8_invalid_offset: utf8FailureOffset(buf),
    head_hex: buf.subarray(0, 32).toString('hex'),
    ascii_head: buf
      .subarray(0, 80)
      .toString('latin1')
      .replace(/[^\x20-\x7e]/g, '.'),
  }
}

const out = {
  schema: 'g-l1-attempt2-acquisition-diagnostic/v1',
  runtime_sha: 'ec7dce912eebd1210f762ddc6092de4d199c3c3b',
  provenance:
    'Replay only — attempt2 durable store retains no URL/bytes (excerpt_only). Same mission, discover query, and ec7 admitted transport as live run.',
  store_bytes_retained: false,
  live_fetch_operation_id: 'cli-run-fetch-wg1-15576886',
  discover_query: discoverQuery,
  discover_status: discover.status,
  discover_failure: discover.status === 'failed' ? discover : undefined,
  candidate_count: candidates.length,
  candidates,
  selected_candidate_index: 0,
  fetch: fetchDiag,
  inference:
    fetchDiag && fetchDiag.magic === 'gzip_magic_1f8b'
      ? 'Likely compressed transport body admitted as raw bytes without decompression before UTF-8 fatal decode in htmlFromAdmittedBytes.'
      : fetchDiag && fetchDiag.magic === 'pdf_magic'
        ? 'Binary PDF selected/treated as HTML text path; UTF-8 decode fails on binary header.'
        : fetchDiag && fetchDiag.utf8_invalid_offset !== null
          ? 'Invalid UTF-8 at reported offset; classify with magic/Content-Type — do not assume truncation without truncated=true.'
          : 'unknown',
}

const outPath = join(repoRoot, 'review-artifacts/general-g-l1-attempt2-acquisition-diagnostic.json')
writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))

#!/usr/bin/env node
/**
 * Bounded acquisition replay for G-L1 attempt2 (no model, no store mutation).
 * Provenance: ec7 admittedHttpGet + same mission/discover query as live run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const babelCli = join(repoRoot, 'babel-cli')

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
  if (buf.length >= 3 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) return 'gzip_magic_1f8b08'
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip_magic_1f8b'
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf_magic'
  return 'other'
}

function headerValue(headers, name) {
  const raw = headers[name.toLowerCase()]
  if (raw === undefined) return null
  return Array.isArray(raw) ? raw.join(', ') : raw
}

function parseContentType(contentTypeHeader) {
  if (!contentTypeHeader) return { media_type: null, charset: null }
  const parts = contentTypeHeader.split(';').map((s) => s.trim())
  const media_type = parts[0] ?? null
  let charset = null
  for (const part of parts.slice(1)) {
    const m = /^charset=(.+)$/i.exec(part)
    if (m) charset = m[1].replace(/^"|"$/g, '')
  }
  return { media_type, charset }
}

/** First index where extending the prefix by one byte makes fatal UTF-8 decode fail. */
function firstFatalUtf8ByteIndex(buf) {
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

function productionFatalUtf8Check(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return { valid: true, error: null }
  } catch (error) {
    return {
      valid: false,
      error: 'admitted bytes are not valid UTF-8',
      decoder_message: error instanceof Error ? error.message : String(error),
    }
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
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
  const headers = http.responseHeaders ?? {}
  const contentTypeHeader = headerValue(headers, 'content-type') ?? http.contentType
  const contentEncodingHeader = headerValue(headers, 'content-encoding')
  const parsedCt = parseContentType(contentTypeHeader)
  const utf8Whole = productionFatalUtf8Check(buf)
  const prefixFatalIndex = utf8Whole.valid ? null : firstFatalUtf8ByteIndex(buf)

  let decompression = null
  if (classifyMagic(buf).startsWith('gzip_magic')) {
    try {
      const plain = gunzipSync(buf)
      const plainUtf8 = productionFatalUtf8Check(plain)
      decompression = {
        algorithm: 'gzip',
        decompressed_byte_length: plain.length,
        decompressed_sha256: sha256(plain),
        decompressed_fatal_utf8: plainUtf8,
        decompressed_head_ascii: plain
          .subarray(0, 120)
          .toString('utf8')
          .replace(/[^\x20-\x7e\n\r\t]/g, '.'),
      }
    } catch (error) {
      decompression = {
        algorithm: 'gzip',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  fetchDiag = {
    replay_url: http.requestedUrl,
    final_url: http.finalUrl,
    redirect_chain: http.redirectChain,
    http_status: http.status,
    ok: http.ok,
    response_headers: {
      'content-type': contentTypeHeader,
      'content-encoding': contentEncodingHeader,
    },
    content_type_parsed: parsedCt,
    bytes_received: http.bytesReceived,
    buffered_length: buf.length,
    truncated: http.truncated,
    sha256: sha256(buf),
    magic: classifyMagic(buf),
    head_hex: buf.subarray(0, 16).toString('hex'),
    utf8_validation: {
      whole_buffer_fatal_utf8: utf8Whole,
      first_prefix_fatal_byte_index: prefixFatalIndex,
      note:
        prefixFatalIndex === 0
          ? null
          : 'Byte 0x1f (if present) is valid UTF-8 ASCII U+001F; failure is not attributed to byte 0 unless index is 0.',
    },
    bounded_decompression: decompression,
  }
}

const out = {
  schema: 'g-l1-attempt2-acquisition-diagnostic/v2',
  runtime_sha: 'ec7dce912eebd1210f762ddc6092de4d199c3c3b',
  epistemic_limits: {
    original_attempt2_store_retains: {
      source_url: false,
      response_headers: false,
      admitted_bytes: false,
      utf8_failure_offset: false,
    },
    replay_proves:
      'Reproducible acquisition defect class under same mission, discover query, and admittedHttpGet transport as live attempt2.',
    replay_does_not_prove: [
      'byte_identical_original_http_response',
      'verified_original_selected_source_url',
    ],
    replay_url_derivation:
      'discover.candidates[0] on this replay (retrieval policy selects first candidate; live store did not persist URL)',
  },
  store_bytes_retained: false,
  live_fetch_operation_id: 'cli-run-fetch-wg1-15576886',
  discover_query: discoverQuery,
  discover_status: discover.status,
  candidate_count: candidates.length,
  candidates,
  selected_candidate_index: 0,
  fetch: fetchDiag,
  inference:
    fetchDiag &&
    fetchDiag.magic.startsWith('gzip_magic') &&
    fetchDiag.utf8_validation.whole_buffer_fatal_utf8.valid === false &&
    fetchDiag.bounded_decompression?.decompressed_fatal_utf8?.valid === true
      ? 'Wire body is gzip-compressed octets admitted without decompression; fatal UTF-8 check runs on compressed bytes (htmlFromAdmittedBytes path). Content-Encoding only if present on response headers.'
      : null,
}

const outPath = join(repoRoot, 'review-artifacts/general-g-l1-attempt2-acquisition-diagnostic.json')
writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))

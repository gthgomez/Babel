import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { GeneralDocumentAdapter } from '../../../adapters/documents/generalDocumentAdapter.js'
import { ResearchMissionV2Schema } from '../../../contracts/mission.js'
import { createGovernedSourceAccessPort } from '../../../access/governedSourceAccessPort.js'
import { createMissionSelectedDocumentSearchProvider } from '../../../access/missionSelectedDocumentSearchProvider.js'
import arxivManifest from './1706.03762.manifest.json' with { type: 'json' }
import {
  assertRegularFileSizeStableAfterRead,
  readBoundedRegularFileAtPath,
  resolveArxiv170603762PaperBytesFromExternalCache,
  resolveCacheFileOpenFlags,
  resolveManifestedPaperBytesFromExternalCache,
  type ArxivPaperCacheReadOptions,
  type CacheFileOpenPlatformSupport,
} from './arxivPaperExternalCache.js'
import { readFileSync } from 'node:fs'
import { dirname, join as pathJoin } from 'node:path'
import { fileURLToPath } from 'node:url'

const campaignDir = pathJoin(dirname(fileURLToPath(import.meta.url)), '..')

const tinyManifest = {
  artifact_path: 'tiny-fixture.pdf',
  content_sha256: createHash('sha256').update('hello-paper').digest('hex'),
  byte_length: 11,
}

function withTempCacheDir(run: (cacheRoot: string) => void): void {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'babel-arxiv-cache-'))
  try {
    run(cacheRoot)
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
}

function missingSafeOpenConstants(): ('O_NOFOLLOW' | 'O_NONBLOCK')[] {
  const missing: ('O_NOFOLLOW' | 'O_NONBLOCK')[] = []
  if (typeof constants.O_NOFOLLOW !== 'number') missing.push('O_NOFOLLOW')
  if (typeof constants.O_NONBLOCK !== 'number') missing.push('O_NONBLOCK')
  return missing
}

function injectedSupportedOpenFlags(): CacheFileOpenPlatformSupport {
  const missing = missingSafeOpenConstants()
  if (missing.length === 0) {
    return {
      supported: true,
      flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      platform_qualification: 'linux_open_nofollow_nonblock',
    }
  }
  return {
    supported: true,
    flags: constants.O_RDONLY,
    platform_qualification: 'linux_open_nofollow_nonblock',
  }
}

function injectedUnsupportedOpenFlags(
  missing: ('O_NOFOLLOW' | 'O_NONBLOCK')[],
): CacheFileOpenPlatformSupport {
  return {
    supported: false,
    status: 'unsupported_platform',
    message: `test injected missing ${missing.join(' and ')}`,
    missing_constants: missing,
    platform_qualification: 'requires_linux_open_nofollow_nonblock',
  }
}

function readOptionsWithSupportedFlags(): ArxivPaperCacheReadOptions {
  return { resolveOpenFlags: injectedSupportedOpenFlags }
}

describe('arxiv external paper cache (isolated temp dirs)', () => {
  it('resolveCacheFileOpenFlags mirrors runtime fs.constants (no silent zero fallback)', () => {
    const flags = resolveCacheFileOpenFlags()
    const missing = missingSafeOpenConstants()
    if (missing.length > 0) {
      assert.equal(flags.supported, false)
      if (flags.supported) return
      assert.equal(flags.status, 'unsupported_platform')
      assert.deepEqual(flags.missing_constants, missing)
    } else {
      assert.equal(flags.supported, true)
      if (!flags.supported) return
      assert.equal(flags.platform_qualification, 'linux_open_nofollow_nonblock')
      assert.equal(flags.flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    }
  })

  it('readBoundedRegularFileAtPath fails closed when injected open flags are unsupported', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'hello-paper')
      const read = readBoundedRegularFileAtPath(path, tinyManifest.byte_length, {
        resolveOpenFlags: () => injectedUnsupportedOpenFlags(['O_NOFOLLOW', 'O_NONBLOCK']),
      })
      assert.equal(read.ok, false)
      if (read.ok) return
      assert.equal(read.status, 'unsupported_platform')
    })
  })

  it('resolveManifestedPaperBytesFromExternalCache surfaces unsupported_platform from injected flags', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'hello-paper')
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, {
        cacheRoot,
        resolveOpenFlags: () => injectedUnsupportedOpenFlags(['O_NONBLOCK']),
      })
      assert.equal(resolved.status, 'unsupported_platform')
      if (resolved.status !== 'unsupported_platform') return
      assert.deepEqual(resolved.missing_constants, ['O_NONBLOCK'])
    })
  })

  it('reports missing cache without reading user home cache', () => {
    withTempCacheDir((cacheRoot) => {
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, { cacheRoot })
      assert.equal(resolved.status, 'missing')
      if (resolved.status !== 'missing') return
      assert.match(resolved.expectedPath, /tiny-fixture\.pdf$/)
      assert.equal(resolved.manifestByteLength, tinyManifest.byte_length)
    })
  })

  it('rejects wrong-size cache before digest work', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'short')
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, {
        cacheRoot,
        ...readOptionsWithSupportedFlags(),
      })
      assert.equal(resolved.status, 'size_mismatch')
      if (resolved.status !== 'size_mismatch') return
      assert.equal(resolved.actualByteLength, 5)
    })
  })

  it('rejects oversized cache when file grew beyond manifest byte_length', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'x'.repeat(tinyManifest.byte_length + 1))
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, {
        cacheRoot,
        ...readOptionsWithSupportedFlags(),
      })
      assert.equal(resolved.status, 'size_mismatch')
      if (resolved.status !== 'size_mismatch') return
      assert.match(resolved.message, /exceeds manifest/)
    })
  })

  it('reports digest_mismatch when size matches but hash differs', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'x'.repeat(tinyManifest.byte_length))
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, {
        cacheRoot,
        ...readOptionsWithSupportedFlags(),
      })
      assert.equal(resolved.status, 'digest_mismatch')
    })
  })

  it('returns ok bytes for matching size and digest', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'hello-paper')
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, {
        cacheRoot,
        ...readOptionsWithSupportedFlags(),
      })
      assert.equal(resolved.status, 'ok')
      if (resolved.status !== 'ok') return
      assert.equal(resolved.bytes.toString('utf8'), 'hello-paper')
    })
  })

  it('readBoundedRegularFileAtPath rejects non-regular files', () => {
    withTempCacheDir((cacheRoot) => {
      const dirPath = join(cacheRoot, 'not-a-file')
      mkdirSync(dirPath)
      const read = readBoundedRegularFileAtPath(dirPath, 10, readOptionsWithSupportedFlags())
      assert.equal(read.ok, false)
      if (read.ok) return
      assert.equal(read.status, 'not_regular_file')
    })
  })

  it('fails closed on FIFO cache paths without blocking when safe open flags are available', () => {
    const runtime = resolveCacheFileOpenFlags()
    if (!runtime.supported) {
      return
    }
    withTempCacheDir((cacheRoot) => {
      const fifoPath = join(cacheRoot, tinyManifest.artifact_path)
      execSync(`mkfifo ${JSON.stringify(fifoPath)}`)
      const read = readBoundedRegularFileAtPath(fifoPath, tinyManifest.byte_length, {
        resolveOpenFlags: () => runtime,
      })
      assert.equal(read.ok, false)
      if (read.ok) return
      assert.ok(read.status === 'not_regular_file' || read.status === 'read_failed')
    })
  })

  it('detects file growth after initial stat when safe open flags are available', () => {
    if (!resolveCacheFileOpenFlags().supported) {
      return
    }
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'hello-paper')
      const fd = openSync(path, constants.O_RDONLY)
      const before = fstatSync(fd)
      assert.equal(before.size, tinyManifest.byte_length)
      writeFileSync(path, 'hello-paper!')
      const stable = assertRegularFileSizeStableAfterRead(fd, tinyManifest.byte_length)
      closeSync(fd)
      assert.equal(stable.ok, false)
      if (stable.ok) return
      assert.equal(stable.status, 'size_mismatch')
    })
  })
})

if (process.env.BABEL_RESEARCH_V2_VERIFY_ARXIV_PAPER_CACHE === '1') {
  describe('arxiv 1706.03762 external paper cache (opt-in verification)', () => {
    it('parses verified external-cache bytes with real pdfjs (not tracked in Git)', async () => {
      const resolved = resolveArxiv170603762PaperBytesFromExternalCache()
      assert.equal(
        resolved.status,
        'ok',
        resolved.status === 'missing'
          ? `external cache missing at ${resolved.expectedPath}`
          : resolved.status === 'size_mismatch'
            ? `size mismatch at ${resolved.resolvedPath}: ${resolved.message}`
            : resolved.status === 'digest_mismatch'
              ? `digest mismatch at ${resolved.resolvedPath}`
              : resolved.status === 'read_failed'
                ? `read failed at ${resolved.resolvedPath}: ${resolved.message}`
                : `cache resolve failed: ${resolved.status}`,
      )
      if (resolved.status !== 'ok') return
      const mission = ResearchMissionV2Schema.parse(
        JSON.parse(readFileSync(pathJoin(campaignDir, 'T-L2-mission.json'), 'utf8')),
      )
      const search = createMissionSelectedDocumentSearchProvider()
      const searchResult = await search.search(
        {
          operationId: 'arxiv-cache-search',
          query: '1706.03762',
          sourceClasses: ['document'],
          signal: new AbortController().signal,
        },
        mission,
      )
      assert.equal(searchResult.status, 'ok')
      if (searchResult.status !== 'ok') return
      const source = searchResult.hits[0]!.source
      const access = createGovernedSourceAccessPort({
        mission,
        searchProvider: search,
        maxAdmittedBytes: 10_000_000,
        admittedGet: async ({ url }) => ({
          ok: true,
          status: 200,
          contentType: 'application/pdf',
          buffer: resolved.bytes,
          bytesReceived: resolved.bytes.length,
          truncated: false,
          requestedUrl: url,
          finalUrl: url,
          redirectChain: [url],
          transportCoding: null,
        }),
      })
      const read = await new GeneralDocumentAdapter().read(
        { operationId: 'arxiv-cache-parser', source, signal: AbortSignal.timeout(120_000) },
        access,
      )
      assert.equal(read.status, 'ok')
      if (read.status !== 'ok') return
      assert.equal(read.revision.content_hash, arxivManifest.content_sha256)
      const lastPage = arxivManifest.expected_pdf_page_count ?? 15
      const lastPassage = read.passages.find(
        (p) => p.locator.kind === 'page' && p.locator.start_page === lastPage,
      )
      assert.ok(lastPassage)
      if (lastPassage!.text_ref.mode === 'inline') {
        assert.match(lastPassage!.text_ref.text, /Law/i)
      }
    })
  })
}

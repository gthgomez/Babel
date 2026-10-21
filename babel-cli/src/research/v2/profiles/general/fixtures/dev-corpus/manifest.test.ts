import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/** All manifest-relative paths resolve from this directory (explicit root). */
const manifestDir = dirname(fileURLToPath(import.meta.url))

interface DevCorpusCase {
  id: string
  title: string
  mission_fixture: string
  sources: string[]
  expectations: string
}

interface DevCorpusManifest {
  schema_version: number
  cases: DevCorpusCase[]
  security_fixtures: string[]
  document_fixtures: string[]
}

const EXPECTED_PDF_PAGE_TEXT = [
  'Page one: retention 90 days.',
  'Page two: effective 2026-03-15.',
] as const

/** Explicit per-case source files (directory non-empty alone is insufficient). */
const REQUIRED_SOURCE_FILES: Record<string, readonly string[]> = {
  'G-DEV-01': ['plan-a.html', 'plan-b.html'],
  'G-DEV-02': ['helio-tab-pro.html', 'orion-lite.html'],
  'G-DEV-03': ['official-policy.txt'],
  'G-DEV-04': ['local-blog.html', 'press-wire-a.html', 'press-wire-b.html', 'widgetship-2025.csv'],
  'G-DEV-05': ['city_report.html', 'metro_survey.html'],
  'G-DEV-06': ['registry-unavailable.json', 'search-snippet-a.txt', 'search-snippet-b.txt'],
}

const EXPECTED_CASE_IDS = [
  'G-DEV-01',
  'G-DEV-02',
  'G-DEV-03',
  'G-DEV-04',
  'G-DEV-05',
  'G-DEV-06',
] as const

function loadManifest(): DevCorpusManifest {
  const raw = JSON.parse(readFileSync(join(manifestDir, 'manifest.json'), 'utf8')) as DevCorpusManifest
  assert.equal(raw.schema_version, 1)
  return raw
}

function resolveManifestPath(relativePath: string): string {
  return resolve(manifestDir, relativePath)
}

function readManifestFile(relativePath: string): Buffer {
  const absolute = resolveManifestPath(relativePath)
  assert.equal(
    existsSync(absolute),
    true,
    `missing manifest asset: ${relativePath} (resolved ${absolute})`,
  )
  return readFileSync(absolute)
}

function parseManifestJson(relativePath: string): Record<string, unknown> {
  const parsed = JSON.parse(readManifestFile(relativePath).toString('utf8')) as unknown
  assert.equal(typeof parsed, 'object')
  assert.notEqual(parsed, null)
  return parsed as Record<string, unknown>
}

function assertRequiredSourceFiles(caseId: string, relativeDir: string): void {
  const required = REQUIRED_SOURCE_FILES[caseId]
  assert.ok(required?.length, `missing REQUIRED_SOURCE_FILES entry for ${caseId}`)
  const absoluteDir = resolveManifestPath(relativeDir)
  assert.equal(existsSync(absoluteDir), true, `missing source directory: ${relativeDir}`)
  for (const fileName of required) {
    const relativeFile = join(relativeDir, fileName).replace(/\\/g, '/')
    readManifestFile(relativeFile)
  }
}

function assertPdfFixtureStructureAndEmbeddedText(relativePath: string): void {
  const bytes = readManifestFile(relativePath)
  assert.ok(bytes.length > 100, 'PDF fixture unexpectedly small')
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-', 'invalid PDF header')
  const embedded = bytes.toString('latin1')
  for (const phrase of EXPECTED_PDF_PAGE_TEXT) {
    assert.match(
      embedded,
      new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `PDF missing expected page text: ${phrase}`,
    )
  }
  const pageObjects = embedded.match(/\/Type\s*\/Page\b/g) ?? []
  assert.ok(pageObjects.length >= 2, `expected ≥2 page objects, saw ${pageObjects.length}`)
}

test('dev-corpus manifest: every declared asset resolves, JSON parses, required source files, PDF fixture structure/text present', () => {
  const manifest = loadManifest()
  assert.equal(manifest.cases.length, 6)
  const ids = manifest.cases.map((c) => c.id).sort()
  assert.deepEqual(ids, [...EXPECTED_CASE_IDS])

  for (const caseEntry of manifest.cases) {
    assert.match(caseEntry.id, /^G-DEV-\d{2}$/)
    for (const sourceDir of caseEntry.sources) {
      assertRequiredSourceFiles(caseEntry.id, sourceDir)
    }
    parseManifestJson(caseEntry.mission_fixture)
    parseManifestJson(caseEntry.expectations)
  }

  for (const securityPath of manifest.security_fixtures) {
    readManifestFile(securityPath)
  }

  let pdfPath: string | undefined
  for (const documentPath of manifest.document_fixtures) {
    readManifestFile(documentPath)
    if (documentPath.endsWith('two-page-sample.pdf')) {
      pdfPath = documentPath
    }
  }
  assert.ok(pdfPath, 'manifest must list two-page-sample.pdf in document_fixtures')
  assertPdfFixtureStructureAndEmbeddedText(pdfPath)
})

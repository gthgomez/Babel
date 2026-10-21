import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { buildAdmittedContent } from '../documents/testAdmittedFixtures.js'
import { MAX_INLINE_PASSAGE_UTF16_UNITS, passageTextHash } from '../documents/passageInlineText.js'
import { resolveQuarantinedFixturePath } from '../documents/quarantinePath.js'
import { passagesFromAdmittedStaticHtml, HTML_MEDIA_TYPE } from './htmlFromAdmittedBytes.js'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../profiles/general/fixtures/dev-corpus',
)

test('passagesFromAdmittedStaticHtml: G-DEV-01 plan-a heading sections', () => {
  const rel = 'G-DEV-01/sources/plan-a.html'
  const bytes = readFileSync(resolveQuarantinedFixturePath(devCorpusRoot, rel))
  const admitted = buildAdmittedContent('op-html', 'src-plan', 'rev-plan', bytes, HTML_MEDIA_TYPE, {
    requestedUrl: 'https://example.invalid/plan-a',
    finalUrl: 'https://example.invalid/plan-a',
    redirectChain: ['https://example.invalid/plan-a'],
  })
  const passages = passagesFromAdmittedStaticHtml(admitted)
  assert.ok(passages.length >= 1)
  assert.equal(passages[0]?.locator.kind, 'section')
  assert.ok(passages[0]?.heading_path?.[0]?.includes('Nimbus'))
  for (const p of passages) PassageRecordSchema.parse(p)
})

test('passagesFromAdmittedStaticHtml: non-ascii repeated headings get unique section_id', () => {
  const html = `<html><body><h1>日本語</h1><p>one</p><h1>日本語</h1><p>two</p></body></html>`
  const admitted = buildAdmittedContent('op', 's', 'r', Buffer.from(html, 'utf8'), HTML_MEDIA_TYPE)
  const passages = passagesFromAdmittedStaticHtml(admitted)
  assert.equal(passages.length, 2)
  const ids = passages.map((p) => (p.locator.kind === 'section' ? p.locator.section_id : ''))
  assert.notEqual(ids[0], ids[1])
  assert.match(ids[0] ?? '', /^heading-[a-f0-9]{16}$/)
  assert.equal(ids[1], `${ids[0]}~2`)
})

test('passagesFromAdmittedStaticHtml: repeated headings get unique section_id', () => {
  const html = `<html><body><h1>Same</h1><p>one</p><h1>Same</h1><p>two</p></body></html>`
  const admitted = buildAdmittedContent('op', 's', 'r', Buffer.from(html, 'utf8'), HTML_MEDIA_TYPE)
  const passages = passagesFromAdmittedStaticHtml(admitted)
  assert.equal(passages.length, 2)
  const ids = passages.map((p) => (p.locator.kind === 'section' ? p.locator.section_id : ''))
  assert.notEqual(ids[0], ids[1])
})

test('passagesFromAdmittedStaticHtml: inline hash matches emitted text', () => {
  const html = `<html><body><h1>H</h1><p>${'z'.repeat(32_001)}</p></body></html>`
  const admitted = buildAdmittedContent('op', 's', 'r', Buffer.from(html, 'utf8'), HTML_MEDIA_TYPE)
  const passages = passagesFromAdmittedStaticHtml(admitted)
  const ref = passages[0]?.text_ref
  assert.equal(ref?.mode, 'inline')
  if (ref?.mode === 'inline') {
    assert.equal(ref.text_hash, passageTextHash(ref.text))
    assert.equal(ref.text.length, MAX_INLINE_PASSAGE_UTF16_UNITS)
    assert.ok(passages[0]?.extraction_notes?.some((n) => n.includes('inline_text_truncated')))
    PassageRecordSchema.parse(passages[0])
  }
})

test('passagesFromAdmittedStaticHtml: long unicode respects UTF-16 schema max', () => {
  const emoji = '😀'
  const body = 'a'.repeat(MAX_INLINE_PASSAGE_UTF16_UNITS - 1) + emoji
  const html = `<html><body><h1>H</h1><p>${body}</p></body></html>`
  const admitted = buildAdmittedContent('op', 's', 'r', Buffer.from(html, 'utf8'), HTML_MEDIA_TYPE)
  const passages = passagesFromAdmittedStaticHtml(admitted)
  const record = passages[0]
  assert.ok(record)
  PassageRecordSchema.parse(record)
  if (record.text_ref.mode === 'inline') {
    assert.equal(record.text_ref.text.length, MAX_INLINE_PASSAGE_UTF16_UNITS - 1)
    assert.equal(record.text_ref.text_hash, passageTextHash(record.text_ref.text))
  }
})

test('passagesFromAdmittedStaticHtml: rejects login-only html', () => {
  const bytes = Buffer.from('<html><body><form><input type="password"/></form></body></html>', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, HTML_MEDIA_TYPE)
  assert.throws(() => passagesFromAdmittedStaticHtml(admitted), /login-only|incomplete/)
})

test('passagesFromAdmittedStaticHtml: rejects non-html media', () => {
  const bytes = Buffer.from('<p>x</p>', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, 'text/plain')
  assert.throws(() => passagesFromAdmittedStaticHtml(admitted), /unsupported media_type/)
})

test('passagesFromAdmittedStaticHtml: nested heading markup yields stable section locators', () => {
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../fixtures/campaign/G-L3-fixtures/devguide-nested-heading-representative.html',
  )
  const bytes = readFileSync(fixturePath)
  const admitted = buildAdmittedContent(
    'op-g-l3-nested-heading',
    'web-devguide-representative',
    'rev-nested-heading',
    bytes,
    HTML_MEDIA_TYPE,
    {
      requestedUrl: 'https://devguide.python.org/versions/',
      finalUrl: 'https://devguide.python.org/versions/',
      redirectChain: ['https://devguide.python.org/versions/'],
    },
  )
  const passages = passagesFromAdmittedStaticHtml(admitted)
  assert.equal(passages.length, 2)
  assert.deepEqual(passages[0]?.heading_path, ['Status of Python versions'])
  assert.deepEqual(passages[1]?.heading_path, ['Release cadence'])
  for (const passage of passages) PassageRecordSchema.parse(passage)
})

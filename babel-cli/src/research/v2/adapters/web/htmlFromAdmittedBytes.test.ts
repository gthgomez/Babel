import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { buildAdmittedContent } from '../documents/testAdmittedFixtures.js'
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

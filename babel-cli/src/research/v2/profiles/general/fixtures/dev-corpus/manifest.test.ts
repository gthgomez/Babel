import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))

test('general dev corpus manifest lists six development cases with assets', () => {
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')) as {
    cases: Array<{ id: string; mission_fixture: string; expectations: string }>
  }
  assert.equal(manifest.cases.length, 6)
  const ids = manifest.cases.map((c) => c.id).sort()
  assert.deepEqual(ids, [
    'G-DEV-01',
    'G-DEV-02',
    'G-DEV-03',
    'G-DEV-04',
    'G-DEV-05',
    'G-DEV-06',
  ])
  for (const caseEntry of manifest.cases) {
    readFileSync(join(here, caseEntry.mission_fixture), 'utf8')
    readFileSync(join(here, caseEntry.expectations), 'utf8')
  }
})

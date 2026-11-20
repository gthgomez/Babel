import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  computePublicApiSurface,
  publicApiFreezeRef,
  publicApiPreservationMode,
  publicApiPreservationViolation,
  requestedExportNames,
  splitPublicApiPreservationStatement,
} from './publicApiPreservation.js'
import type { TaskContractProvenanceRecord } from './taskContract.js'

function surfaceFixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-api-preservation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'value.mjs'), 'export const value = 1\n')
  return root
}

function freezeRecords(root: string, mode: 'exact' | 'compatible'): TaskContractProvenanceRecord[] {
  const surface = computePublicApiSurface(root)
  assert.ok(surface)
  return [{ kind: 'derived_acceptance', ref: publicApiFreezeRef(surface, { mode }) }]
}

test('preservation wording distinguishes exact from compatible', () => {
  assert.equal(publicApiPreservationMode('Fix src/value.mjs. Do not change public APIs.'), 'exact')
  assert.equal(publicApiPreservationMode('Keep the public API unchanged.'), 'exact')
  assert.equal(publicApiPreservationMode('Keep existing exports backward compatible. Do not break public APIs.'), 'compatible')
  assert.equal(publicApiPreservationMode('Add value 2 without breaking the public API.'), 'compatible')
  assert.equal(publicApiPreservationMode('Fix src/value.mjs so value is 2.'), 'exact', 'unclassified text fails closed')
})

test('explicitly requested additive exports are extracted', () => {
  assert.deepEqual(requestedExportNames('Add a `doubled` export to src/value.mjs.'), ['doubled'])
  assert.deepEqual(requestedExportNames('Add an export named sum to src/math.js.'), ['sum'])
  assert.deepEqual(requestedExportNames('Do not change public APIs.'), [])
})

test('a clean preservation sentence splits from a behavioral sentence', () => {
  assert.deepEqual(
    splitPublicApiPreservationStatement('Fix src/value.mjs so value is 2. Do not change public APIs.'),
    { behavior: 'Fix src/value.mjs so value is 2.', preservation: 'Do not change public APIs.' },
  )
  assert.deepEqual(
    splitPublicApiPreservationStatement('Do not change public APIs.'),
    { behavior: null, preservation: 'Do not change public APIs.' },
  )
})

test('a compound sentence is not split and cannot be demoted', () => {
  assert.equal(
    splitPublicApiPreservationStatement('Fix src/value.mjs so value is 2 and do not change public APIs.'),
    null,
  )
  assert.equal(
    splitPublicApiPreservationStatement('Do not change public APIs; keep the CLI working.'),
    null,
  )
  assert.equal(
    splitPublicApiPreservationStatement('Please do not change public APIs.'),
    null,
    'incidental lead-in text keeps the whole requirement mandatory',
  )
})

test('compatible mode permits additions but refuses removals and renames', t => {
  const root = surfaceFixture(t)
  const records = freezeRecords(root, 'compatible')
  writeFileSync(join(root, 'src', 'value.mjs'), 'export const value = 1\nexport const doubled = 2\n')
  assert.equal(publicApiPreservationViolation({ records, projectRoot: root }), null)

  writeFileSync(join(root, 'src', 'value.mjs'), 'export const doubled = 1\nexport const extra = 2\n')
  assert.match(
    publicApiPreservationViolation({ records, projectRoot: root }) ?? '',
    /public API surface changed: export name:value was removed or renamed/,
  )
})

test('exact mode refuses an unrequested addition and permits a requested one', t => {
  const root = surfaceFixture(t)
  const records = freezeRecords(root, 'exact')
  writeFileSync(join(root, 'src', 'value.mjs'), 'export const value = 1\nexport const doubled = 2\n')
  assert.match(
    publicApiPreservationViolation({ records, projectRoot: root }) ?? '',
    /added under an exact preservation constraint/,
  )
  assert.equal(
    publicApiPreservationViolation({ records, projectRoot: root, requestedExports: ['doubled'] }),
    null,
  )
})

test('legacy v1 records replay with exact semantics', t => {
  const root = surfaceFixture(t)
  const surface = computePublicApiSurface(root)
  assert.ok(surface)
  const ref = `babel:public-api-freeze:v1:${surface.digest}:${Buffer.from(JSON.stringify(Object.keys(surface.files)), 'utf8').toString('base64url')}`
  writeFileSync(join(root, 'src', 'value.mjs'), 'export const value = 1\nexport const doubled = 2\n')
  assert.match(
    publicApiPreservationViolation({ records: [{ kind: 'derived_acceptance', ref }], projectRoot: root }) ?? '',
    /public API surface changed/,
  )
})

test('an unreadable freeze record fails closed', t => {
  const root = surfaceFixture(t)
  for (const ref of [
    'babel:public-api-freeze:v2:not-a-payload',
    'babel:public-api-freeze:v2:',
    'babel:public-api-freeze:v1:broken',
  ]) {
    assert.equal(
      publicApiPreservationViolation({ records: [{ kind: 'derived_acceptance', ref }], projectRoot: root }),
      'public API preservation record is unreadable',
      ref,
    )
  }
})

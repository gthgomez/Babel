/**
 * Provenance validator: makes benchmarks/PROVENANCE.json mechanically
 * auditable instead of a human assertion.
 *
 * Proves, against the live repository:
 *  1. every sha256 matches the shipped bytes (RECOVERED claims are real),
 *  2. every structured selector resolves to exactly one object,
 *  3. newly authored canonical material is never labeled as recovered
 *     historical truth,
 *  4. no machine-local paths leak into the record.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'

import { BABEL_ROOT } from '../cli/constants.js'

const KNOWN_CLASSIFICATIONS = new Set([
  'RECOVERED_EXACT',
  'RECOVERED_FROM_ARTIFACT',
  'RECOVERED_EXACT_PLUS_CANONICAL_ADDITION',
  'NEW_CANONICAL_REPLACEMENT',
])

interface ProvenanceEntry {
  classification: string
  sha256?: string
  source_artifact: string
  source_date: string
  sanitized: boolean
  note?: string
  subentries?: Array<{
    selector: { file: string; kind: string; value: string }
    classification: string
    source_artifact: string
    sanitized: boolean
    note?: string
  }>
}

const provenancePath = join(BABEL_ROOT, 'benchmarks', 'PROVENANCE.json')
const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as {
  schema_version: number
  entries: Record<string, ProvenanceEntry>
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Entry keys are relative to benchmarks/. */
function benchmarkPath(rel: string): string {
  return join(BABEL_ROOT, 'benchmarks', rel)
}

test('provenance uses only known classifications', () => {
  for (const [path, entry] of Object.entries(provenance.entries)) {
    assert.ok(
      KNOWN_CLASSIFICATIONS.has(entry.classification),
      `${path}: unknown classification ${entry.classification}`,
    )
    for (const sub of entry.subentries ?? []) {
      assert.ok(
        KNOWN_CLASSIFICATIONS.has(sub.classification),
        `${path}: unknown subentry classification ${sub.classification}`,
      )
    }
  }
})

test('every sha256 matches the shipped bytes', () => {
  for (const [rel, entry] of Object.entries(provenance.entries)) {
    if (!entry.sha256) continue
    const actual = sha256File(benchmarkPath(rel))
    assert.equal(
      actual,
      entry.sha256,
      `${rel}: provenance fingerprint does not match committed content`,
    )
  }
})

test('every structured selector resolves to exactly one object', () => {
  let selectorCount = 0
  for (const [parentRel, entry] of Object.entries(provenance.entries)) {
    for (const sub of entry.subentries ?? []) {
      selectorCount += 1
      assert.equal(sub.selector.kind, 'task_id', 'supported selector kind')
      assert.equal(sub.selector.file, parentRel, 'selector must target its parent file')
      const target = JSON.parse(
        readFileSync(benchmarkPath(sub.selector.file), 'utf8'),
      ) as { tasks?: Array<{ task_id?: string }> }
      const matches = (target.tasks ?? []).filter((t) => t.task_id === sub.selector.value)
      assert.equal(
        matches.length,
        1,
        `selector ${sub.selector.file}#${sub.selector.kind}=${sub.selector.value} resolved ${matches.length} objects`,
      )
    }
  }
  assert.ok(selectorCount >= 1, 'expected at least one structured selector to validate')
})

test('newly authored canonical material is never labeled as recovered truth', () => {
  const canonicalSub = provenance.entries['task-manifest.json']?.subentries?.find(
    (s) => s.selector.value === 'canonical',
  )
  assert.ok(canonicalSub, 'canonical subsection must be declared')
  assert.equal(canonicalSub.classification, 'NEW_CANONICAL_REPLACEMENT')
  assert.equal(canonicalSub.source_artifact, 'constructed-in-repo')

  // And the parent does not claim pure exactness without acknowledging the addition.
  assert.equal(
    provenance.entries['task-manifest.json'].classification,
    'RECOVERED_EXACT_PLUS_CANONICAL_ADDITION',
  )
})

test('no machine-local paths leak into the provenance record', () => {
  const raw = readFileSync(provenancePath, 'utf8')
  assert.doesNotMatch(raw, /[A-Za-z]:[\\/](Users|Workspace|home)/)
  assert.doesNotMatch(raw, /AppData/)
})

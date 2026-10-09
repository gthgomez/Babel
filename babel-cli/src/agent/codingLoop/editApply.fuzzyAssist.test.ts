/**
 * Fuzzy assist wiring in applyUniqueEdit's not_found failure path.
 *
 * - similarity >= 0.90 with a unique candidate: auto-applies (fuzzy_assist)
 * - similarity 0.70–0.89: scored suggestion surfaced, nothing applied
 * - similarity < 0.70: unchanged failure
 * - two equal-similarity >= 0.90 candidates: never auto-applies
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { applyUniqueEdit, formatEditObservation } from './editApply.js'

describe('edit apply fuzzy assist', () => {
  test('similarity >= 0.90 auto-applies as fuzzy_assist', () => {
    const content = 'alpha\nconst value = 2\nomega\n'
    const result = applyUniqueEdit({
      content,
      oldStr: 'const value = 1',
      newStr: 'const value = 9',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.matchKind, 'fuzzy_assist')
    assert.equal(result.content, 'alpha\nconst value = 9\nomega\n')
    assert.ok(result.fuzzySimilarity !== undefined)
    assert.ok(result.fuzzySimilarity >= 0.9, `similarity ${result.fuzzySimilarity}`)
    assert.match(result.diff, /const value = 9/)
    assert.match(formatEditObservation('src/x.ts', result), /fuzzy_assist/)
  })

  test('similarity 0.70–0.89 surfaces scored suggestion without applying', () => {
    const content = 'aaaaaaaaxx\nother\n'
    const result = applyUniqueEdit({
      content,
      oldStr: 'aaaaaaaaaa',
      newStr: 'aaaaaaaaab',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'not_found')
    assert.ok(result.fuzzySuggestion, 'expected fuzzySuggestion')
    assert.equal(result.fuzzySuggestion.startLine, 1)
    assert.equal(result.fuzzySuggestion.endLine, 1)
    assert.ok(
      result.fuzzySuggestion.similarity >= 0.7 && result.fuzzySuggestion.similarity < 0.9,
      `similarity ${result.fuzzySuggestion.similarity}`,
    )
    assert.match(result.message, /did you mean lines 1-1 \(similarity 0\.8\d\)\?/)
    assert.equal(content.includes('aaaaaaaaab'), false)
  })

  test('similarity < 0.70 leaves the failure unchanged', () => {
    const result = applyUniqueEdit({
      content: 'bbbbbbbbbb\n',
      oldStr: 'aaaaaaaaaa',
      newStr: 'cccccccccc',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'not_found')
    assert.equal(result.message, 'str_replace: old_str not found in file')
    assert.equal(result.fuzzySuggestion, undefined)
  })

  test('two equal-similarity >= 0.90 candidates never auto-apply', () => {
    const content = 'const value = 2\nconst value = 3\n'
    const result = applyUniqueEdit({
      content,
      oldStr: 'const value = 1',
      newStr: 'const value = 9',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'not_found')
    assert.ok(result.fuzzySuggestion, 'expected scored suggestion for ambiguity')
    assert.ok(result.fuzzySuggestion.similarity >= 0.9)
    assert.equal(content.includes('const value = 9'), false)
  })
})

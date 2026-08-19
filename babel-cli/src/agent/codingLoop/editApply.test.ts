import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { applyUniqueEdit, detectLineEnding, formatEditObservation } from './editApply.js'

describe('edit apply (shipped applyUniqueEdit)', () => {
  test('exact unique match applies and surfaces the changed range', () => {
    const content = 'function add(a, b) {\n  return a - b\n}\n'
    const result = applyUniqueEdit({
      content,
      oldStr: 'return a - b',
      newStr: 'return a + b',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.content, /return a \+ b/)
    assert.equal(result.matchKind, 'exact')
    assert.equal(result.startLine, 2)
    assert.match(result.diff, /return a - b/)
    assert.match(result.diff, /return a \+ b/)
    assert.match(formatEditObservation('src/add.ts', result), /lines 2-2/)
  })

  test('unique whitespace-drift match is tolerated', () => {
    const content = '  foo()\n  bar()\n'
    const result = applyUniqueEdit({
      content,
      oldStr: 'foo()\nbar()',
      newStr: 'foo()\nbaz()',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.matchKind === 'line_trim' || result.matchKind === 'whitespace_normalized')
    assert.match(result.content, /baz\(\)/)
  })

  test('ambiguous match is rejected, not silently applied to multiple locations', () => {
    const content = 'x = 1\nother\nx = 1\n'
    const result = applyUniqueEdit({
      content,
      oldStr: 'x = 1',
      newStr: 'x = 2',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'ambiguous')
    assert.equal(result.matchCount, 2)
    assert.equal(content.includes('x = 2'), false)
  })

  test('line-trim ±1 match replaces only the located block, not the neighbor', () => {
    // oldStr has trailing spaces + an extra newline, so its split length is 3
    // while the unique line-trim hit is the first 2 lines. Using oldStr's
    // line count as the replace length would delete `neighbor`.
    const content = 'foo\nbar\nneighbor\n'
    const result = applyUniqueEdit({
      content,
      oldStr: 'foo  \nbar\n',
      newStr: 'foo\nbaz',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.matchKind, 'line_trim')
    assert.equal(result.content, 'foo\nbaz\nneighbor\n')
    assert.match(result.content, /neighbor/)
    assert.doesNotMatch(result.diff, /neighbor/)
  })

  test('preserves CRLF and a leading BOM', () => {
    const content = '\uFEFFline one\r\nline two\r\nline three\r\n'
    assert.equal(detectLineEnding(content.slice(1)), 'crlf')
    const result = applyUniqueEdit({
      content,
      oldStr: 'line two',
      newStr: 'line TWO',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.lineEnding, 'crlf')
    assert.ok(result.content.startsWith('\uFEFF'))
    assert.match(result.content, /line TWO\r\n/)
    assert.ok(!result.content.includes('line TWO\nline') || result.content.includes('\r\n'))
  })
})

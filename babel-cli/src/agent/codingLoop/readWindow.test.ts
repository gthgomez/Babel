import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  decideReadInjection,
  evaluateReadRequest,
  formatReadObservation,
  invalidateReadCacheForPath,
  makeReadInjectionKey,
  selectReadWindow,
  type ReadInjectionCache,
} from './readWindow.js'

function fixtureLines(count: number): string {
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    lines.push(`LINE_${String(i).padStart(4, '0')} content for fixture row ${i}`)
  }
  return lines.join('\n')
}

describe('read window + injection keys (shipped)', () => {
  test('bounded first read returns only its window and names what remains', () => {
    const content = fixtureLines(420)
    const window = selectReadWindow(content, { kind: 'full' }, { maxLines: 80 })
    assert.equal(window.startLine, 1)
    assert.equal(window.endLine, 80)
    assert.equal(window.totalLines, 420)
    assert.equal(window.truncated, true)
    assert.equal(window.remainingAfter, 340)
    assert.ok(window.numberedText.startsWith('1:LINE_0001'))
    assert.ok(!window.numberedText.includes('LINE_0200'))
    const obs = formatReadObservation('read_file', 'big.ts', window)
    assert.match(obs, /returned lines 1-80 of 420/)
    assert.match(obs, /340 lines after remain/)
  })

  test('range 200-250 returns those lines even when a prior full read hashed equal', () => {
    const content = fixtureLines(420)
    const hash = 'abc123'
    const cache: ReadInjectionCache = new Map()
    const pathKey = 'src/big.ts'
    const first = evaluateReadRequest({
      pathKey,
      fileHash: hash,
      content,
      request: { kind: 'full' },
      cache,
      maxLines: 80,
    })
    assert.equal(first.decision.skip, false)
    assert.equal(first.window.endLine, 80)

    const sameHashRange = decideReadInjection({
      pathKey,
      fileHash: hash,
      request: { kind: 'range', startLine: 200, endLine: 250 },
      cache,
    })
    assert.equal(sameHashRange.skip, false, 'range must not skip because path hash matches a full read')
    assert.notEqual(sameHashRange.cacheKey, makeReadInjectionKey(pathKey, { kind: 'full' }))

    const served = evaluateReadRequest({
      pathKey,
      fileHash: hash,
      content,
      request: { kind: 'range', startLine: 200, endLine: 250 },
      cache,
    })
    assert.equal(served.decision.skip, false)
    assert.equal(served.window.startLine, 200)
    assert.equal(served.window.endLine, 250)
    assert.equal(served.window.lines.length, 51, '200-250 inclusive is 51 lines, not a 200-line default cap')
    assert.equal(
      served.window.truncated,
      false,
      'a fully served range is not a truncated window',
    )
    assert.match(served.window.numberedText, /^200:LINE_0200 content for fixture row 200\n/)
    assert.match(served.window.numberedText, /\n250:LINE_0250 content for fixture row 250$/)
    for (let n = 200; n <= 250; n++) {
      const tag = `LINE_${String(n).padStart(4, '0')}`
      assert.ok(served.window.numberedText.includes(`${n}:${tag}`), `missing ${n}:${tag}`)
    }
    assert.ok(!served.window.numberedText.includes('LINE_0080'))
    const obs = formatReadObservation('read_range', 'src/big.ts', served.window)
    assert.match(obs, /returned requested lines 200-250 of 420 in full/)
    assert.match(obs, /^200:LINE_0200 content for fixture row 200$/m)
    assert.match(obs, /^250:LINE_0250 content for fixture row 250$/m)
    assert.equal((obs.match(/^2[0-4]\d:LINE_/gm) ?? []).length + (obs.match(/^250:LINE_/gm) ?? []).length, 51)
  })

  test('repeated identical full read may skip only after that same full request was served', () => {
    const content = fixtureLines(50)
    const cache: ReadInjectionCache = new Map()
    const first = evaluateReadRequest({
      pathKey: 'src/small.ts',
      fileHash: 'h1',
      content,
      request: { kind: 'full' },
      cache,
    })
    assert.equal(first.decision.skip, false)
    const second = evaluateReadRequest({
      pathKey: 'src/small.ts',
      fileHash: 'h1',
      content,
      request: { kind: 'full' },
      cache,
    })
    assert.equal(second.decision.skip, true)
    assert.equal(second.decision.reason, 'identical_full_served')
  })

  test('mutation invalidates stale read-cache state so a later read is fresh', () => {
    const before = fixtureLines(40)
    const cache: ReadInjectionCache = new Map()
    evaluateReadRequest({
      pathKey: 'src/a.ts',
      fileHash: 'old',
      content: before,
      request: { kind: 'range', startLine: 1, endLine: 10 },
      cache,
    })
    invalidateReadCacheForPath(cache, 'src/a.ts')
    const after = before.replace('LINE_0005', 'LINE_0005 patched')
    const again = evaluateReadRequest({
      pathKey: 'src/a.ts',
      fileHash: 'new',
      content: after,
      request: { kind: 'range', startLine: 1, endLine: 10 },
      cache,
    })
    assert.equal(again.decision.skip, false)
    assert.match(again.window.numberedText, /LINE_0005 patched/)
  })

  test('range requests never skip merely because file bytes are unchanged after a different range', () => {
    const content = fixtureLines(300)
    const cache: ReadInjectionCache = new Map()
    evaluateReadRequest({
      pathKey: 'x.ts',
      fileHash: 'same',
      content,
      request: { kind: 'range', startLine: 1, endLine: 20 },
      cache,
    })
    const other = decideReadInjection({
      pathKey: 'x.ts',
      fileHash: 'same',
      request: { kind: 'range', startLine: 80, endLine: 90 },
      cache,
    })
    assert.equal(other.skip, false)
  })
})

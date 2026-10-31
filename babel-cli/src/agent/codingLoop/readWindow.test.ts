import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  decideReadInjection,
  evaluateReadRequest,
  formatReadFailureObservation,
  formatReadObservation,
  formatReadWindowBanner,
  invalidateReadCacheForPath,
  makeReadInjectionKey,
  selectReadWindow,
  readFileWindow,
  type ReadInjectionCache,
} from './readWindow.js'

function fixtureLines(count: number): string {
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    lines.push(`LINE_${String(i).padStart(4, '0')} content for fixture row ${i}`)
  }
  return lines.join('\n')
}

describe('streaming read range windows', () => {
  test('preserves CRLF and UTF-8 lines across small stream chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-read-window-'))
    const path = join(dir, 'chunked.txt')
    try {
      writeFileSync(path, 'one\r\ntwø\r\nthree')
      const result = await readFileWindow(path, { kind: 'range', startLine: 2, endLine: 2 }, { chunkBytes: 3 })
      assert.deepEqual(result.window.lines, ['twø'])
      assert.equal(result.window.totalLines, 3)
      assert.equal(result.window.byteTruncated, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('caps an overlong selected line and marks the read byte-truncated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-read-window-'))
    const path = join(dir, 'long.txt')
    try {
      writeFileSync(path, `${'x'.repeat(5000)}\nnext`)
      const result = await readFileWindow(path, { kind: 'range', startLine: 1, endLine: 2 }, {
        maxLineBytes: 1024,
        chunkBytes: 128,
      })
      assert.equal(result.window.totalLines, 2)
      assert.equal(result.window.byteTruncated, true)
      assert.match(result.window.numberedText, /line clipped/)
      assert.doesNotMatch(formatReadObservation('read_range', 'long.txt', result.window), /complete file/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('caps total selected bytes on line boundaries and reports the retained range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-read-window-'))
    const path = join(dir, 'many-lines.txt')
    try {
      writeFileSync(path, 'first\nsecond\nthird\nfourth')
      const result = await readFileWindow(path, { kind: 'range', startLine: 1, endLine: 4 }, {
        maxBytes: 13,
        chunkBytes: 4,
      })
      assert.deepEqual(result.window.lines, ['first'])
      assert.equal(result.window.endLine, 1)
      assert.equal(result.window.remainingAfter, 3)
      assert.equal(result.window.byteTruncated, true)
      const observation = formatReadObservation('read_range', 'many-lines.txt', result.window)
      assert.match(observation, /retained selected content: \d+ bytes; total source scanned: \d+ bytes/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects a cancelled read before opening the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-read-window-'))
    const path = join(dir, 'cancel.txt')
    const controller = new AbortController()
    controller.abort()
    try {
      writeFileSync(path, 'line')
      await assert.rejects(readFileWindow(path, { kind: 'range', startLine: 1, endLine: 1 }, { signal: controller.signal }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('clips a range beyond EOF and supports parallel bounded reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-read-window-'))
    try {
      const paths = Array.from({ length: 3 }, (_, index) => {
        const path = join(dir, `parallel-${index}.txt`)
        writeFileSync(path, `a${index}\nb${index}`)
        return path
      })
      const results = await Promise.all(paths.map((path) =>
        readFileWindow(path, { kind: 'range', startLine: 2, endLine: 10 }, { chunkBytes: 2 }),
      ))
      assert.deepEqual(results.map((result) => result.window.lines[0]), ['b0', 'b1', 'b2'])
      assert.ok(results.every((result) => result.window.truncated && result.window.totalLines === 2))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

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

  test('explicit 1-1000 is full when available; 1-1001 is capped; beyond EOF clips', () => {
    const content = fixtureLines(1500)
    const fullCap = selectReadWindow(content, { kind: 'range', startLine: 1, endLine: 1000 })
    assert.equal(fullCap.lines.length, 1000)
    assert.equal(fullCap.truncated, false)
    const capped = selectReadWindow(content, { kind: 'range', startLine: 1, endLine: 1001 })
    assert.equal(capped.lines.length, 1000)
    assert.equal(capped.truncated, true)
    assert.equal(capped.requestedEndLine, 1001)
    assert.equal(capped.nextSuggestedStartLine, 1001)
    const banner = formatReadWindowBanner('huge.ts', capped)
    assert.match(banner, /requested range 1-1001/)
    assert.match(banner, /returned range 1-1000/)
    const pastEof = selectReadWindow(content, { kind: 'range', startLine: 1490, endLine: 2000 })
    assert.equal(pastEof.endLine, 1500)
    assert.equal(pastEof.truncated, true)
    assert.equal(pastEof.lines.length, 11)
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

  test('failed reads render failure evidence with the true exit status', () => {
    const obs = formatReadFailureObservation({
      tool: 'read_file',
      target: 'missing.ts',
      exitCode: 1,
      stdout: '',
      stderr: 'ENOENT: no such file or directory',
      toolCallId: 'call-read-1',
    })
    assert.match(obs, /exit_code: 1/)
    assert.match(obs, /ENOENT/)
    assert.doesNotMatch(obs, /exit_code: 0/)
  })

  test('a new context epoch cannot reuse an identical prior read', () => {
    const cache: ReadInjectionCache = new Map()
    const input = {
      pathKey: 'src/context.ts',
      fileHash: 'same-bytes',
      request: { kind: 'full' as const },
      cache,
    }
    assert.equal(decideReadInjection({ ...input, contextEpoch: 0 }).skip, false)
    cache.set(makeReadInjectionKey('src/context.ts', { kind: 'full' }, 0), {
      hash: 'same-bytes',
      timestamp: Date.now(),
      requestKey: makeReadInjectionKey('src/context.ts', { kind: 'full' }, 0),
    })
    assert.equal(decideReadInjection({ ...input, contextEpoch: 1 }).skip, false)
  })
})

test('line windows count delivered lines consistently for terminal newlines and empty files', () => {
  for (const content of ['a\nb\n', 'a\r\nb\r\n']) {
    const window = selectReadWindow(content, { kind: 'full' })
    assert.equal(window.totalLines, 2)
    assert.equal(window.endLine, 2)
    assert.deepEqual(window.lines, ['a', 'b'])
  }
  const empty = selectReadWindow('', { kind: 'full' })
  assert.equal(empty.totalLines, 0)
  assert.equal(empty.endLine, 0)
  assert.deepEqual(empty.lines, [])
})

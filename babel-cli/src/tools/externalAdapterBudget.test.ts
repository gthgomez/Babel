import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  boundExternalText,
  resolveExternalToolMaxOutputBytes,
  resolveExternalToolTimeoutMs,
  runBoundedExternalProcess,
} from './externalAdapterBudget.js'
import { handleWebSearch } from './webContext.js'

test('external output budget is bounded, byte-based and does not split code points', () => {
  const text = 'a'.repeat(10) + 'é'.repeat(10)
  const bounded = boundExternalText(text, 15)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.bytes, Buffer.byteLength(text, 'utf8'))
  assert.ok(bounded.retained_bytes <= 15)
  assert.equal(bounded.text, 'a'.repeat(10) + 'é'.repeat(2),
    'a retained partial UTF-8 sequence must be dropped')
  assert.equal(boundExternalText('short', 15).truncated, false)
})

test('external adapter limits honor explicit environment ceilings', () => {
  assert.equal(resolveExternalToolMaxOutputBytes({ BABEL_EXTERNAL_TOOL_MAX_BYTES: '1234' }), 1234)
  assert.equal(resolveExternalToolMaxOutputBytes({ BABEL_EXTERNAL_TOOL_MAX_BYTES: 'nope' }), 200_000)
  assert.equal(resolveExternalToolTimeoutMs({ BABEL_EXTERNAL_TOOL_TIMEOUT_MS: '4321' }), 4321)
})

test('bounded helper process settles once and caps retained stdout', async () => {
  const script = "process.stdout.write('x'.repeat(50_000)); process.stderr.write('y'.repeat(100));"
  const result = await runBoundedExternalProcess({
    command: process.execPath,
    args: ['-e', script],
    maxBytes: 1_024,
    timeoutMs: 10_000,
  })
  assert.equal(result.exit_code, 0)
  assert.equal(result.timed_out, false)
  assert.equal(result.settled, true)
  assert.equal(result.stdout_truncated, true)
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1_024)
  assert.equal(result.stderr_truncated, false)
  assert.match(result.stderr, /y{100}/)
})

test('bounded helper process terminates its owned tree on timeout', async () => {
  const script = "setInterval(() => {}, 1_000); process.stdout.write('started');"
  const started = Date.now()
  const result = await runBoundedExternalProcess({
    command: process.execPath,
    args: ['-e', script],
    maxBytes: 1_024,
    timeoutMs: 500,
  })
  assert.equal(result.timed_out, true)
  assert.equal(result.settled, true)
  assert.match(result.stdout, /started/)
  assert.ok(Date.now() - started < 5_000, 'timeout must settle without waiting for the helper')
})

test('web_search retains bounded response bytes and discloses the limit', async (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-web-search-budget-'))
  const previous = process.env['BABEL_WEB_MAX_BYTES']
  process.env['BABEL_WEB_MAX_BYTES'] = '2048'
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(
      `<a class="result__a" href="https://example.test/a">Example A</a>${'z'.repeat(10_000)}`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    ))
  try {
    const result = await handleWebSearch(
      { tool: 'web_search', query: 'example' },
      { runId: 'budget', runDir, babelRoot: runDir },
    )
    assert.equal(result.exit_code, 0)
    const payload = JSON.parse(result.stdout) as {
      results: Array<{ url: string }>
      limits: { max_bytes: number; bytes_received: number; truncated: boolean }
    }
    assert.equal(payload.limits.max_bytes, 2048)
    assert.equal(payload.limits.truncated, true)
    assert.ok(payload.limits.bytes_received > payload.limits.max_bytes)
    assert.deepEqual(payload.results.map(result => result.url), ['https://example.test/a'])
  } finally {
    if (previous === undefined) delete process.env['BABEL_WEB_MAX_BYTES']
    else process.env['BABEL_WEB_MAX_BYTES'] = previous
    rmSync(runDir, { recursive: true, force: true })
  }
})

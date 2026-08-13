import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildTuiVisualReceipt,
  evaluateTuiSemanticOracle,
  readTuiEventStream,
} from './tuiVisualEvidence.js'
import { TUI_VISUAL_SCENARIOS } from './tuiVisualScenarioCatalog.js'

test('event reader preserves valid records and counts malformed lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-tui-visual-events-'))
  const path = join(dir, 'events.jsonl')
  await writeFile(path, '{"event":"babel.stream.started"}\nnot-json\n{"event":"babel.stream.ended"}\n')

  const result = await readTuiEventStream(path)

  assert.equal(result.missing, false)
  assert.equal(result.records.length, 2)
  assert.equal(result.malformedLines, 1)
})

test('semantic oracle passes UI-only scenarios without an event stream', () => {
  const result = evaluateTuiSemanticOracle({
    records: [],
    expectedEvents: [],
    stream: { missing: true, malformedLines: 0 },
  })

  assert.equal(result.passed, true)
  assert.match(result.detail, /0 required event/)
})

test('semantic oracle requires the event stream when events are expected', () => {
  const result = evaluateTuiSemanticOracle({
    records: [],
    expectedEvents: ['babel.stream.started'],
    stream: { missing: true, malformedLines: 0 },
  })

  assert.equal(result.passed, false)
  assert.match(result.detail, /Event stream file was not produced/)
})

test('receipt adds a deterministic finding when semantic evidence fails', () => {
  const scenario = TUI_VISUAL_SCENARIOS[0]!
  const semantic = evaluateTuiSemanticOracle({
    records: [],
    expectedEvents: ['babel.stream.started'],
    stream: { missing: true, malformedLines: 0 },
  })
  const receipt = buildTuiVisualReceipt({
    scenario,
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:00:01.000Z',
    terminal: {
      program: 'Windows Terminal',
      term: 'xterm-256color',
      cols: 120,
      rows: 40,
      platform: 'win32',
      isWindowsTerminal: true,
    },
    semantic,
    observations: [],
    evidenceDir: 'runs/tui-visual/scenario',
    controller: { name: 'luna', version: 'test' },
  })

  assert.equal(receipt.status, 'INCONCLUSIVE')
  assert.equal(receipt.findings.length, 1)
  assert.match(receipt.findings[0]!.summary, /Semantic oracle failed/)
})

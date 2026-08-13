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

test('explicit visual-only scenarios pass without semantic evidence and say so', () => {
  const result = evaluateTuiSemanticOracle({
    records: [],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    stream: { missing: true, malformedLines: 0 },
  })

  assert.equal(result.passed, true)
  assert.equal(result.evidenceRequired, false)
  assert.match(result.detail, /not required/)
})

test('semantic oracle requires the event stream when events are expected', () => {
  const result = evaluateTuiSemanticOracle({
    records: [],
    evidenceMode: 'visual_plus_semantic',
    expectedEvents: ['babel.stream.started'],
    stream: { missing: true, malformedLines: 0 },
  })

  assert.equal(result.passed, false)
  assert.match(result.detail, /Event stream file was not produced/)
})

test('semantic-required scenarios cannot pass with an empty expectation or missing stream', () => {
  const result = evaluateTuiSemanticOracle({
    records: [],
    evidenceMode: 'visual_plus_semantic',
    expectedEvents: [],
    stream: { missing: true, malformedLines: 0 },
  })

  assert.equal(result.passed, false)
  assert.equal(result.evidenceRequired, true)

  const presentButEmpty = evaluateTuiSemanticOracle({
    records: [{ event: 'babel.stream.started' }],
    evidenceMode: 'visual_plus_semantic',
    expectedEvents: [],
    stream: { missing: false, malformedLines: 0 },
  })
  assert.equal(presentButEmpty.passed, false)
})

test('semantic oracle rejects malformed streams, missing events, and accepts complete evidence', () => {
  const expectedEvents = ['babel.diff.review.opened', 'babel.diff.review.closed']
  const malformed = evaluateTuiSemanticOracle({
    records: expectedEvents.map((event) => ({ event })),
    evidenceMode: 'visual_plus_semantic',
    expectedEvents,
    stream: { missing: false, malformedLines: 1 },
  })
  assert.equal(malformed.passed, false)

  const missing = evaluateTuiSemanticOracle({
    records: [{ event: expectedEvents[0]! }],
    evidenceMode: 'visual_plus_semantic',
    expectedEvents,
    stream: { missing: false, malformedLines: 0 },
  })
  assert.equal(missing.passed, false)
  assert.deepEqual(missing.missingEvents, [expectedEvents[1]])

  const complete = evaluateTuiSemanticOracle({
    records: expectedEvents.filter((event): event is string => event !== undefined).map((event) => ({ event })),
    evidenceMode: 'visual_plus_semantic',
    expectedEvents,
    stream: { missing: false, malformedLines: 0 },
  })
  assert.equal(complete.passed, true)
})

test('receipt adds a deterministic finding when semantic evidence fails', () => {
  const scenario = {
    ...TUI_VISUAL_SCENARIOS[0]!,
    evidenceMode: 'visual_plus_semantic' as const,
    expectedEvents: ['babel.stream.started'],
  }
  const semantic = evaluateTuiSemanticOracle({
    records: [],
    evidenceMode: 'visual_plus_semantic',
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

test('visual evidence failure prevents a visual PASS receipt', () => {
  const semantic = evaluateTuiSemanticOracle({
    records: [],
    evidenceMode: 'visual_plus_semantic',
    expectedEvents: ['babel.diff.review.closed'],
    stream: { missing: false, malformedLines: 0 },
  })
  const receipt = buildTuiVisualReceipt({
    scenario: TUI_VISUAL_SCENARIOS.find(({ id }) => id === 'T20-visual-diff-roundtrip')!,
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:00:01.000Z',
    terminal: { program: 'test', term: 'xterm', cols: 80, rows: 24, platform: 'win32', isWindowsTerminal: false },
    semantic,
    observations: [],
    evidenceDir: 'runs/tui-visual/scenario',
    controller: { name: 'test', version: '1' },
  })

  assert.equal(receipt.status, 'INCONCLUSIVE')
  assert.equal(receipt.semantic.evidenceRequired, true)
})

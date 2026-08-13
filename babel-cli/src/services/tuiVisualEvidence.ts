/**
 * Semantic evidence helpers for external TUI visual-test runners.
 *
 * Visual findings come from the controller's vision model. Babel contributes
 * the independent event-stream oracle so a screenshot-only hallucination does
 * not become a passing or failing result by itself.
 */

import { readFile } from 'node:fs/promises'

import type {
  TuiSemanticOracle,
  TuiVisualFinding,
  TuiVisualReceipt,
  TuiVisualScenario,
  TuiTerminalIdentity,
  TuiVisualObservation,
} from './tuiVisualTestContract.js'
import { TUI_VISUAL_TEST_SCHEMA_VERSION } from './tuiVisualTestContract.js'

export interface TuiEventRecord {
  event?: string
  event_type?: string
  sequence?: number
  payload?: Record<string, unknown>
}

/** Parsed JSONL stream plus evidence-integrity diagnostics. */
export interface TuiEventStreamRead {
  path: string
  records: TuiEventRecord[]
  malformedLines: number
  missing: boolean
}

/**
 * Read an event stream without allowing malformed telemetry to crash the
 * visual controller.
 *
 * @param path JSONL event stream path.
 * @returns Parsed records and corruption/missing-file diagnostics.
 */
export async function readTuiEventStream(path: string): Promise<TuiEventStreamRead> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? (error as Error & { code?: string }).code
      : undefined
    if (code === 'ENOENT') {
      return { path, records: [], malformedLines: 0, missing: true }
    }
    throw error
  }

  const records: TuiEventRecord[] = []
  let malformedLines = 0
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        malformedLines++
        continue
      }
      records.push(value as TuiEventRecord)
    } catch {
      malformedLines++
    }
  }

  return { path, records, malformedLines, missing: false }
}

function eventName(record: TuiEventRecord): string | undefined {
  return record.event ?? record.event_type
}

function payloadString(record: TuiEventRecord, key: string): string | undefined {
  const value = record.payload?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Evaluate required event names against a captured Babel JSONL stream.
 *
 * @param records Captured Babel event records.
 * @param expectedEvents Required event names from the scenario.
 * @param stream Missing/malformed stream metadata.
 * @returns Independent semantic pass/fail result.
 */
export function evaluateTuiSemanticOracle(input: {
  records: TuiEventRecord[]
  expectedEvents: string[]
  stream?: Pick<TuiEventStreamRead, 'missing' | 'malformedLines'>
}): TuiSemanticOracle {
  const observedEvents = input.records
    .map(eventName)
    .filter((event): event is string => event !== undefined)
  const missingEvents = input.expectedEvents.filter((event) => !observedEvents.includes(event))
  const runResult = [...input.records].reverse().find((record) => eventName(record) === 'babel.run.result')
  const streamEnded = [...input.records].reverse().find((record) => eventName(record) === 'babel.stream.ended')
  const runDir = payloadString(runResult ?? {}, 'run_dir') ?? payloadString(streamEnded ?? {}, 'run_dir')
  const finalStatus = payloadString(runResult ?? {}, 'status') ?? payloadString(streamEnded ?? {}, 'status')
  const malformed = input.stream?.malformedLines ?? 0
  const missing = input.stream?.missing ?? false
  const streamRequired = input.expectedEvents.length > 0
  const passed = (!streamRequired || !missing) && malformed === 0 && missingEvents.length === 0

  let detail = passed
    ? `Observed all ${input.expectedEvents.length} required event(s).`
    : `Missing required events: ${missingEvents.join(', ') || '(none)'}.`
  if (missing && streamRequired) detail = 'Event stream file was not produced.'
  if (malformed > 0) detail += ` Ignored ${malformed} malformed line(s).`

  return {
    passed,
    observedEvents,
    missingEvents,
    ...(runDir !== undefined ? { runDir } : {}),
    ...(finalStatus !== undefined ? { finalStatus } : {}),
    detail,
  }
}

function statusRank(status: TuiVisualFinding['status']): number {
  return { INCONCLUSIVE: 1, BLOCKED: 2, BUG: 3 }[status]
}

function semanticFinding(semantic: TuiSemanticOracle): TuiVisualFinding {
  return {
    status: 'INCONCLUSIVE',
    severity: 'high',
    summary: `Semantic oracle failed: ${semantic.detail}`,
    confidence: 1,
    screenshotRefs: [],
    eventRefs: semantic.missingEvents,
    reproSteps: ['Repeat the scenario and inspect the event stream before trusting visual output.'],
  }
}

/**
 * Build a complete receipt from controller observations and Babel evidence.
 *
 * @param input Receipt inputs from the external driver.
 * @returns A deterministic receipt suitable for JSON serialization.
 */
export function buildTuiVisualReceipt(input: {
  scenario: TuiVisualScenario
  startedAt: string
  endedAt: string
  terminal: TuiTerminalIdentity
  semantic: TuiSemanticOracle
  observations: TuiVisualObservation[]
  findings?: TuiVisualFinding[]
  evidenceDir: string
  controller: { name: string; version: string }
}): TuiVisualReceipt {
  const findings = [...(input.findings ?? [])]
  if (!input.semantic.passed) findings.push(semanticFinding(input.semantic))

  const highestFinding = findings
    .slice()
    .sort((a, b) => statusRank(b.status) - statusRank(a.status))[0]
  const status = highestFinding?.status ?? 'PASS'

  return {
    schemaVersion: TUI_VISUAL_TEST_SCHEMA_VERSION,
    scenarioId: input.scenario.id,
    scenarioName: input.scenario.name,
    status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    terminal: input.terminal,
    semantic: input.semantic,
    observations: input.observations,
    findings,
    evidenceDir: input.evidenceDir,
    controller: input.controller,
  }
}

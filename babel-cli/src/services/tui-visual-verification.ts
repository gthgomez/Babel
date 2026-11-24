/**
 * Artifact-backed verification for native TUI visual receipts. The launcher
 * supplies the expected run and owns a private, settled evidence directory.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import {
  tuiCheckpointLabel,
  validateTuiVisualReceipt,
  validateTuiVisualScenario,
  type TuiScenarioValidation,
  type TuiTerminalIdentity,
  type TuiVisualCheck,
  type TuiVisualObservation,
  type TuiVisualReceipt,
  type TuiVisualRunIdentity,
  type TuiVisualScenario,
} from './tuiVisualTestContract.js'

const SHA256 = /^[a-f0-9]{64}$/
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_IEND = Buffer.from('0000000049454e44ae426082', 'hex')
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024

export interface TuiVisualPassExpectation {
  scenario: TuiVisualScenario
  run: TuiVisualRunIdentity
  startedAt: string
  endedAt: string
  terminal: TuiTerminalIdentity
  evidenceDir: string
  /** Independent reviewer output, not copied from an untrusted receipt. */
  checks: readonly TuiVisualCheck[]
}

function sameRun(actual: TuiVisualRunIdentity | undefined, expected: TuiVisualRunIdentity): boolean {
  return actual?.sessionId === expected.sessionId &&
    actual.revision === expected.revision && actual.buildId === expected.buildId
}

function sameTerminal(actual: TuiTerminalIdentity, expected: TuiTerminalIdentity): boolean {
  return actual.program === expected.program && actual.term === expected.term &&
    actual.platform === expected.platform && actual.isWindowsTerminal === expected.isWindowsTerminal &&
    actual.cols === expected.cols && actual.rows === expected.rows
}

function isoMilliseconds(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN
}

async function screenshotMatches(root: string, observation: TuiVisualObservation): Promise<boolean> {
  const parts = observation.screenshotPath.split('/')
  if (!parts.every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part)) ||
    !parts.at(-1)?.endsWith('.png')) return false
  const path = join(root, ...parts)

  try {
    // Refuse aliases and linked paths; the evidence root is assigned by the
    // launcher and must not be writable by the application or other sessions.
    if (await realpath(path) !== path) return false
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await file.stat()
      const { size, nlink } = info
      if (!info.isFile() || nlink !== 1 || size < 45 || size > MAX_SCREENSHOT_BYTES) return false
      const bytes = Buffer.alloc(size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      return offset === size && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
        bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
        bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
        bytes.subarray(size - PNG_IEND.length, size).equals(PNG_IEND) &&
        createHash('sha256').update(bytes.subarray(0, size)).digest('hex') === observation.screenshotSha256
    } finally {
      await file.close()
    }
  } catch {
    return false
  }
}

/**
 * Verify a PASS claim against a trusted scenario/run, reviewer checks and
 * actual screenshot bytes. This checks provenance metadata and byte
 * integrity, not the truth of pixel interpretations or native capture itself.
 */
export async function verifyTuiVisualPass(
  receipt: TuiVisualReceipt,
  expected: TuiVisualPassExpectation,
): Promise<TuiScenarioValidation> {
  const structure = validateTuiVisualReceipt(receipt)
  if (!structure.ok) return structure
  if (receipt.status !== 'PASS') return { ok: false, errors: ['The receipt does not claim PASS.'] }
  const { scenario, run } = expected
  const scenarioValidation = validateTuiVisualScenario(scenario)
  if (!scenarioValidation.ok) return scenarioValidation
  if (
    !run.sessionId.trim() || !REVISION.test(run.revision) || !SHA256.test(run.buildId) ||
    !sameRun(receipt.run, run) || receipt.scenarioId !== scenario.id ||
    receipt.scenarioName !== scenario.name || receipt.evidenceDir !== expected.evidenceDir ||
    !sameTerminal(receipt.terminal, expected.terminal) ||
    receipt.startedAt !== expected.startedAt || receipt.endedAt !== expected.endedAt
  ) return { ok: false, errors: ['Receipt does not match the expected scenario and run.'] }
  if (scenario.evidenceMode !== receipt.semantic.evidenceMode || scenario.evidenceMode !== 'visual_only') {
    return { ok: false, errors: ['The event-name oracle does not certify run-bound semantic criteria.'] }
  }
  const start = isoMilliseconds(expected.startedAt)
  const end = isoMilliseconds(expected.endedAt)
  if (!(start <= end && end <= Date.now())) return { ok: false, errors: ['Invalid capture window.'] }
  if (!Number.isSafeInteger(expected.terminal.cols) || expected.terminal.cols <= 0 ||
    !Number.isSafeInteger(expected.terminal.rows) || expected.terminal.rows <= 0) {
    return { ok: false, errors: ['Invalid launch terminal dimensions.'] }
  }
  if (receipt.observations.length !== scenario.steps.length) {
    return { ok: false, errors: ['Expected one observation per scenario step.'] }
  }

  let lastTime = start
  let terminal = expected.terminal
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const [index, step] of scenario.steps.entries()) {
    const observation = receipt.observations[index]!
    const time = isoMilliseconds(observation.timestamp)
    if (step.action === 'resize') terminal = { ...terminal, cols: step.cols, rows: step.rows }
    if (
      !observation.id.trim() || ids.has(observation.id) ||
      paths.has(observation.screenshotPath.toLowerCase()) ||
      !(lastTime <= time && time <= end) || observation.label !== tuiCheckpointLabel(step) ||
      !sameRun(observation.run, run) || observation.captureKind !== 'native_terminal' ||
      !sameTerminal(observation.terminal, terminal) ||
      !SHA256.test(observation.screenshotSha256 ?? '')
    ) return { ok: false, errors: [`Checkpoint ${index + 1} has invalid or mismatched capture metadata.`] }
    lastTime = time
    ids.add(observation.id)
    paths.add(observation.screenshotPath.toLowerCase())
  }

  const matchesCheck = (checks: readonly TuiVisualCheck[], criterionId: string, observation: TuiVisualObservation): boolean =>
    checks.some((check) => check.criterionId === criterionId && check.outcome === 'met' &&
      check.observationId === observation.id && check.screenshotSha256 === observation.screenshotSha256)
  if (receipt.checks.length !== scenario.expectedVisualStates.length ||
    expected.checks.length !== scenario.expectedVisualStates.length) {
    return { ok: false, errors: ['Expected one positive check per mandatory visual criterion.'] }
  }
  for (const { id, afterStep } of scenario.expectedVisualStates) {
    const observation = receipt.observations[afterStep]!
    if (!matchesCheck(receipt.checks, id, observation) || !matchesCheck(expected.checks, id, observation)) {
      return { ok: false, errors: [`A mandatory criterion lacks a matching positive check: ${id}.`] }
    }
  }

  const root = await realpath(expected.evidenceDir).catch(() => undefined)
  if (!root) return { ok: false, errors: ['The evidence directory is unavailable.'] }
  for (const [index, observation] of receipt.observations.entries()) {
    if (!await screenshotMatches(root, observation)) {
      return { ok: false, errors: [`Checkpoint ${index + 1} has a missing or invalid screenshot artifact.`] }
    }
  }
  return { ok: true }
}

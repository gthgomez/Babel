/**
 * Contracts shared by Babel's TUI visual-test manifest and external drivers.
 *
 * The computer-use implementation stays outside Babel. This module defines
 * the safe action vocabulary, the visual evidence references, and the receipt
 * shape that an external Luna runner can produce and validate.
 */

export const TUI_VISUAL_TEST_SCHEMA_VERSION = 1 as const

/** Safety boundary for scenario actions. */
export type TuiVisualSafety = 'read_only' | 'fixture_mutation'

/** Terminal result classification for a visual scenario. */
export type TuiVisualStatus = 'PASS' | 'BUG' | 'BLOCKED' | 'INCONCLUSIVE'

/** Whether the scenario claims an independent runtime-event oracle. */
export type TuiVisualEvidenceMode = 'visual_only' | 'visual_plus_semantic'

/** Severity assigned to a controller finding. */
export type TuiVisualSeverity = 'low' | 'medium' | 'high' | 'critical'

/** Allow-listed action vocabulary understood by external controllers. */
export type TuiVisualStep =
  | { action: 'observe'; label: string }
  | { action: 'press_key'; key: string; label: string }
  | { action: 'type_text'; text: string; label: string }
  | { action: 'resize'; cols: number; rows: number; label: string }
  | { action: 'wait'; milliseconds: number; label: string }

export interface TuiVisualScenario {
  /** Stable identifier used in receipts and evidence directory names. */
  id: string
  /** Human-readable scenario name. */
  name: string
  /** Scenario may only use read-only UI actions or may mutate a fixture. */
  safety: TuiVisualSafety
  /** Ordered, allow-listed actions for the external computer-use adapter. */
  steps: TuiVisualStep[]
  /** Explicitly states whether semantic runtime evidence is required. */
  evidenceMode: TuiVisualEvidenceMode
  /** Event names that must be observed for the semantic oracle to pass. */
  expectedEvents: string[]
  /** Labels interpreted by the vision agent as expected screen states. */
  expectedVisualStates: string[]
}

export interface TuiTerminalIdentity {
  program: string
  term: string
  cols: number
  rows: number
  platform: string
  isWindowsTerminal: boolean
}

/**
 * Adapter boundary implemented by an authorized computer-use controller.
 *
 * Implementations must observe after every action and must not add arbitrary
 * terminal commands or controls beyond the scenario vocabulary.
 */
export interface TuiVisualController {
  /** Capture the current terminal screen and identity. */
  observe(label: string): Promise<TuiVisualObservation>
  /** Send one allow-listed key to the target terminal. */
  pressKey(key: string): Promise<void>
  /** Type scenario-provided text into the target terminal. */
  typeText(text: string): Promise<void>
  /** Resize the target terminal to the requested dimensions. */
  resize(cols: number, rows: number): Promise<void>
  /** Wait for the requested settling interval. */
  wait(milliseconds: number): Promise<void>
}

/** A screenshot-backed point-in-time terminal observation. */
export interface TuiVisualObservation {
  id: string
  label: string
  timestamp: string
  screenshotPath: string
  screenshotSha256?: string
  terminal: TuiTerminalIdentity
}

/** Vision-model or controller finding attached to evidence references. */
export interface TuiVisualFinding {
  status: Exclude<TuiVisualStatus, 'PASS'>
  severity: TuiVisualSeverity
  summary: string
  confidence: number
  screenshotRefs: string[]
  eventRefs: string[]
  reproSteps: string[]
}

/** Independent semantic result derived from Babel runtime evidence. */
export interface TuiSemanticOracle {
  passed: boolean
  evidenceMode: TuiVisualEvidenceMode
  evidenceRequired: boolean
  observedEvents: string[]
  missingEvents: string[]
  runDir?: string
  finalStatus?: string
  detail: string
}

/** Persisted result for one scenario execution. */
export interface TuiVisualReceipt {
  schemaVersion: typeof TUI_VISUAL_TEST_SCHEMA_VERSION
  scenarioId: string
  scenarioName: string
  status: TuiVisualStatus
  startedAt: string
  endedAt: string
  terminal: TuiTerminalIdentity
  semantic: TuiSemanticOracle
  observations: TuiVisualObservation[]
  findings: TuiVisualFinding[]
  evidenceDir: string
  controller: {
    name: string
    version: string
  }
}

/** Runtime validation result for a scenario or receipt. */
export type TuiScenarioValidation =
  | { ok: true }
  | { ok: false; errors: string[] }

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function validateStep(step: TuiVisualStep, index: number, errors: string[]): void {
  if (!isNonEmpty(step.label)) errors.push(`steps[${index}].label must be non-empty`)

  switch (step.action) {
    case 'observe':
    case 'press_key':
    case 'type_text':
      if (step.action === 'press_key' && !isNonEmpty(step.key)) {
        errors.push(`steps[${index}].key must be non-empty`)
      }
      break
    case 'resize':
      if (!Number.isInteger(step.cols) || step.cols < 20) {
        errors.push(`steps[${index}].cols must be an integer >= 20`)
      }
      if (!Number.isInteger(step.rows) || step.rows < 8) {
        errors.push(`steps[${index}].rows must be an integer >= 8`)
      }
      break
    case 'wait':
      if (!Number.isInteger(step.milliseconds) || step.milliseconds < 0) {
        errors.push(`steps[${index}].milliseconds must be a non-negative integer`)
      }
      break
  }
}

/**
 * Validate a scenario before handing it to a computer-use controller.
 *
 * @param scenario Scenario manifest to validate.
 * @returns A successful result or actionable validation errors.
 */
export function validateTuiVisualScenario(
  scenario: TuiVisualScenario,
): TuiScenarioValidation {
  const errors: string[] = []
  if (!isNonEmpty(scenario.id)) errors.push('id must be non-empty')
  if (!isNonEmpty(scenario.name)) errors.push('name must be non-empty')
  if (scenario.steps.length === 0) errors.push('steps must not be empty')
  if (scenario.expectedVisualStates.length === 0) {
    errors.push('expectedVisualStates must not be empty')
  }
  if (scenario.evidenceMode === 'visual_plus_semantic' && scenario.expectedEvents.length === 0) {
    errors.push('visual_plus_semantic scenarios must require at least one expected event')
  }
  if (scenario.evidenceMode === 'visual_only' && scenario.expectedEvents.length > 0) {
    errors.push('visual_only scenarios must not declare expected semantic events')
  }
  if (scenario.evidenceMode !== 'visual_only' && scenario.evidenceMode !== 'visual_plus_semantic') {
    errors.push('evidenceMode must be visual_only or visual_plus_semantic')
  }
  scenario.steps.forEach((step, index) => validateStep(step, index, errors))

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/**
 * Validate a complete receipt before publishing it as bug evidence.
 *
 * @param receipt Receipt emitted by an external visual-test runner.
 * @returns A successful result or receipt validation errors.
 */
export function validateTuiVisualReceipt(receipt: TuiVisualReceipt): TuiScenarioValidation {
  const errors: string[] = []
  if (receipt.schemaVersion !== TUI_VISUAL_TEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${TUI_VISUAL_TEST_SCHEMA_VERSION}`)
  }
  if (!isNonEmpty(receipt.scenarioId)) errors.push('scenarioId must be non-empty')
  if (!isNonEmpty(receipt.evidenceDir)) errors.push('evidenceDir must be non-empty')
  if (receipt.status === 'PASS' && receipt.findings.length > 0) {
    errors.push('PASS receipts must not contain findings')
  }
  if (receipt.status === 'PASS' && !receipt.semantic.passed) {
    errors.push('PASS receipts require passing semantic evidence')
  }
  if (receipt.semantic.evidenceMode === 'visual_plus_semantic' && !receipt.semantic.evidenceRequired) {
    errors.push('semantic-required receipts must record evidenceRequired=true')
  }
  if (receipt.semantic.evidenceMode === 'visual_only' && receipt.semantic.evidenceRequired) {
    errors.push('visual-only receipts must record evidenceRequired=false')
  }
  if (receipt.status !== 'PASS' && receipt.findings.length === 0) {
    errors.push('non-PASS receipts must contain at least one finding')
  }
  for (const finding of receipt.findings) {
    if (finding.confidence < 0 || finding.confidence > 1) {
      errors.push('finding confidence must be between 0 and 1')
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

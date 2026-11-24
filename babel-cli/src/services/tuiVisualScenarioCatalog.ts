/**
 * Initial read-only scenario catalog for an external Luna visual driver.
 *
 * These scenarios cover the interactive states already represented by the
 * T01–T24 daily-driver certification, but describe the actions and visual
 * states a real terminal controller must exercise.
 */

import type { TuiVisualCriterion, TuiVisualScenario } from './tuiVisualTestContract.js'

const observe = (label: string): { action: 'observe'; label: string } => ({
  action: 'observe',
  label,
})

const press = (key: string, label: string): { action: 'press_key'; key: string; label: string } => ({
  action: 'press_key',
  key,
  label,
})

const typeText = (text: string, label: string): { action: 'type_text'; text: string; label: string } => ({
  action: 'type_text',
  text,
  label,
})

const resize = (cols: number, rows: number, label: string): {
  action: 'resize'
  cols: number
  rows: number
  label: string
} => ({ action: 'resize', cols, rows, label })

const wait = (milliseconds: number, label: string): {
  action: 'wait'
  milliseconds: number
  label: string
} => ({ action: 'wait', milliseconds, label })

const check = (id: string, afterStep: number, description: string): TuiVisualCriterion => ({
  id,
  afterStep,
  description,
})

/** Read-only scenarios safe to run against a dedicated Babel TUI window. */
export const TUI_VISUAL_SCENARIOS: readonly TuiVisualScenario[] = [
  {
    id: 'T01-visual-clean-start',
    name: 'Clean unconfigured start gives setup guidance',
    safety: 'read_only',
    steps: [
      observe('initial unconfigured screen'),
      resize(60, 22, 'resize unconfigured terminal'),
      wait(300, 'observe settled narrow setup'),
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('single-welcome', 0, 'Babel startup banner or welcome appears once'),
      check('setup-guidance', 0, 'Provider setup or actionable missing-configuration guidance is visible'),
      check('authentication-unverified', 0, 'No verified provider, account, or model readiness is claimed'),
      check('narrow-guidance', 2, 'Setup instructions and the current input prompt remain readable after narrowing'),
    ],
  },
  {
    id: 'T01-visual-returning-start',
    name: 'Returning configured profile shows one ready composer',
    safety: 'read_only',
    steps: [observe('initial returning screen')],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('single-banner', 0, 'BABEL banner appears once'),
      check('chat-mode', 0, 'CHAT mode is visible'),
      check('ready-prompt', 0, 'Ready prompt is visible'),
      check('no-repeated-setup', 0, 'The ready composer is not obscured by first-run setup'),
    ],
  },
  {
    id: 'T06-visual-clear-composer',
    name: 'Idle Ctrl+C clears composer text without exiting',
    safety: 'read_only',
    steps: [
      typeText('draft that should be cleared', 'type draft'),
      observe('draft visible'),
      press('Control+C', 'cancel draft'),
      observe('composer restored'),
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('draft-present', 1, 'Draft is visible before cancellation'),
      check('draft-cleared', 3, 'Composer is empty after Ctrl+C'),
      check('process-alive', 3, 'Babel remains alive at its ready prompt, not the shell prompt'),
    ],
  },
  {
    id: 'T08-visual-cancel-paste',
    name: 'Ctrl+C cancels multiline paste mode',
    safety: 'read_only',
    steps: [
      typeText('```\nfirst pasted line', 'begin paste'),
      observe('paste mode visible'),
      press('Control+C', 'cancel paste'),
      observe('paste cancelled'),
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('paste-line-count', 1, 'Paste line count is visible'),
      check('cancel-notice', 3, 'Paste cancelled notice is visible'),
      check('prompt-restored', 3, 'Normal prompt is restored'),
    ],
  },
  {
    id: 'T10-visual-resize-draft',
    name: 'Resize preserves the composer draft',
    safety: 'read_only',
    steps: [
      typeText('draft survives resize', 'type resize draft'),
      resize(80, 24, 'resize narrow'),
      observe('narrow layout'),
      resize(120, 40, 'resize wide'),
      observe('wide layout'),
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('narrow-draft', 2, 'Draft remains readable after narrow resize'),
      check('wide-draft', 4, 'Draft remains present after wide resize'),
      check('single-header', 4, 'No duplicate idle header'),
    ],
  },
  {
    id: 'T19-visual-resume-cancel',
    name: 'Cancelling the resume picker does not submit phantom input',
    safety: 'read_only',
    steps: [
      typeText('/resume', 'open resume picker'),
      press('Enter', 'submit resume command'),
      wait(300, 'wait for picker'),
      observe('resume picker'),
      press('Escape', 'cancel picker'),
      observe('composer restored'),
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('picker-open', 3, 'Resume picker is visible'),
      check('picker-closed', 5, 'Picker closes on Escape'),
      check('not-submitted', 5, 'Resume text is not submitted as a task'),
    ],
  },
  {
    id: 'T20-visual-diff-roundtrip',
    name: 'Closing diff review restores the composer',
    safety: 'read_only',
    steps: [
      typeText('/diff', 'open diff review'),
      press('Enter', 'submit diff command'),
      wait(300, 'wait for diff view'),
      observe('diff view'),
      press('q', 'close diff view'),
      observe('composer restored'),
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('diff-open', 3, 'Diff view is visible'),
      check('diff-closed', 5, 'Diff view closes on q'),
      check('composer-usable', 5, 'Composer is usable after closing'),
    ],
  },
  {
    id: 'T21-visual-unicode-narrow',
    name: 'Unicode and wide characters remain legible in a narrow terminal',
    safety: 'read_only',
    steps: [
      resize(40, 16, 'resize narrow'),
      typeText('Unicode: 你好 😀 🔥 café', 'type unicode'),
      observe('unicode composer'),
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('no-overlap', 2, 'Wide characters do not overlap'),
      check('aligned-cursor', 2, 'Cursor remains aligned'),
      check('visible-prompt', 2, 'Prompt remains visible'),
    ],
  },
  {
    id: 'T22-visual-exit-restore',
    name: 'Exit restores cursor and terminal layout',
    safety: 'read_only',
    steps: [
      press('Control+C', 'request exit hint'),
      press('Control+C', 'confirm exit'),
      observe('post-exit terminal'),
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [
      check('visible-cursor', 2, 'Cursor is visible after exit'),
      check('scroll-restored', 2, 'Scroll region is restored'),
      check('no-screen-residue', 2, 'No alternate-screen residue remains'),
    ],
  },
]

/**
 * Return a scenario by stable identifier.
 *
 * @param id Scenario identifier.
 * @returns The matching scenario, or undefined.
 */
export function tuiVisualScenarioById(id: string): TuiVisualScenario | undefined {
  return TUI_VISUAL_SCENARIOS.find((scenario) => scenario.id === id)
}

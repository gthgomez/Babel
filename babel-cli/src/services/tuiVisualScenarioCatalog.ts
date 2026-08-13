/**
 * Initial read-only scenario catalog for an external Luna visual driver.
 *
 * These scenarios cover the interactive states already represented by the
 * T01–T24 daily-driver certification, but describe the actions and visual
 * states a real terminal controller must exercise.
 */

import type { TuiVisualScenario } from './tuiVisualTestContract.js'

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

/** Read-only scenarios safe to run against a dedicated Babel TUI window. */
export const TUI_VISUAL_SCENARIOS: readonly TuiVisualScenario[] = [
  {
    id: 'T01-visual-clean-start',
    name: 'Clean start shows one ready prompt',
    safety: 'read_only',
    steps: [observe('initial ready screen')],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: ['BABEL banner appears once', 'CHAT mode is visible', 'ready prompt is visible'],
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
    expectedVisualStates: ['draft is visible before cancellation', 'composer is empty after Ctrl+C', 'process remains alive'],
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
    expectedVisualStates: ['paste line count is visible', 'paste cancelled notice is visible', 'normal prompt is restored'],
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
    expectedVisualStates: ['draft remains readable after narrow resize', 'draft remains present after wide resize', 'no duplicate idle header'],
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
    expectedVisualStates: ['resume picker is visible', 'picker closes on Escape', 'resume text is not submitted as a task'],
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
    expectedVisualStates: ['diff view is visible', 'diff view closes on q', 'composer is usable after closing'],
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
    expectedVisualStates: ['wide characters do not overlap', 'cursor remains aligned', 'prompt remains visible'],
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
    expectedVisualStates: ['cursor is visible after exit', 'scroll region is restored', 'no alternate-screen residue remains'],
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

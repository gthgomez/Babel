import assert from 'node:assert/strict'
import test from 'node:test'

import { driveTuiVisualScenario } from './tuiVisualDriver.js'
import { TUI_VISUAL_SCENARIOS } from './tuiVisualScenarioCatalog.js'
import type {
  TuiVisualController,
  TuiVisualObservation,
} from './tuiVisualTestContract.js'

function makeController(calls: string[]): TuiVisualController {
  let observation = 0
  const observe = async (label: string): Promise<TuiVisualObservation> => {
    calls.push(`observe:${label}`)
    observation++
    return {
      id: `observation-${observation}`,
      label,
      timestamp: '2026-08-12T00:00:00.000Z',
      screenshotPath: `screenshots/${observation}.png`,
      terminal: {
        program: 'Windows Terminal',
        term: 'xterm-256color',
        cols: 120,
        rows: 40,
        platform: 'win32',
        isWindowsTerminal: true,
      },
    }
  }

  return {
    observe,
    async pressKey(key) {
      calls.push(`press:${key}`)
    },
    async typeText(text) {
      calls.push(`type:${text}`)
    },
    async resize(cols, rows) {
      calls.push(`resize:${cols}x${rows}`)
    },
    async wait(milliseconds) {
      calls.push(`wait:${milliseconds}`)
    },
  }
}

test('driver observes after each action and preserves explicit observations', async () => {
  const calls: string[] = []
  const observations = await driveTuiVisualScenario({
    scenario: TUI_VISUAL_SCENARIOS.find(({ id }) => id === 'T10-visual-resize-draft')!,
    controller: makeController(calls),
  })

  assert.equal(observations.length, 5)
  assert.deepEqual(calls, [
    'type:draft survives resize',
    'observe:type resize draft (after)',
    'resize:80x24',
    'observe:resize narrow (after)',
    'observe:narrow layout',
    'resize:120x40',
    'observe:resize wide (after)',
    'observe:wide layout',
  ])
})

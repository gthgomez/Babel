/**
 * Scenario driver for an external computer-use adapter.
 *
 * This module owns the observe → one action → observe discipline, while the
 * controller owns the platform-specific screenshot and input implementation.
 */

import type {
  TuiVisualController,
  TuiVisualObservation,
  TuiVisualScenario,
} from './tuiVisualTestContract.js'
import { validateTuiVisualScenario } from './tuiVisualTestContract.js'

/**
 * Execute one allow-listed scenario through an external controller.
 *
 * @param input Scenario and authorized computer-use controller.
 * @returns Observations captured at each explicit and post-action checkpoint.
 * @throws Error when the scenario is invalid or the controller action fails.
 */
export async function driveTuiVisualScenario(input: {
  scenario: TuiVisualScenario
  controller: TuiVisualController
}): Promise<TuiVisualObservation[]> {
  const validation = validateTuiVisualScenario(input.scenario)
  if (!validation.ok) {
    throw new Error(`Invalid TUI visual scenario: ${validation.errors.join('; ')}`)
  }

  const observations: TuiVisualObservation[] = []
  for (const step of input.scenario.steps) {
    switch (step.action) {
      case 'observe':
        observations.push(await input.controller.observe(step.label))
        break
      case 'press_key':
        await input.controller.pressKey(step.key)
        observations.push(await input.controller.observe(`${step.label} (after)`))
        break
      case 'type_text':
        await input.controller.typeText(step.text)
        observations.push(await input.controller.observe(`${step.label} (after)`))
        break
      case 'resize':
        await input.controller.resize(step.cols, step.rows)
        observations.push(await input.controller.observe(`${step.label} (after)`))
        break
      case 'wait':
        await input.controller.wait(step.milliseconds)
        observations.push(await input.controller.observe(`${step.label} (after)`))
        break
    }
  }

  return observations
}

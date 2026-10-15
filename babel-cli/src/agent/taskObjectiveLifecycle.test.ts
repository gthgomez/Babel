import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'
import {
  assertObjectiveLifecycle,
  type TaskObjectiveLifecycleV1,
} from './taskObjectiveLifecycle.js'

test('a retained conversation exceeding 5000 messages does not exhaust objective history', () => {
  const objectives = Array.from({ length: 2501 }, (_, index) => ({
    taskContract: freezeTaskContract(
      buildTaskContractV1({
        mode: 'chat',
        task_id: `fixture-task-${index}`,
        user_request: `Explain fixture ${index}`,
        acceptance_criteria: [`Explain fixture ${index}`],
      }),
    ),
  }))
  const attempts = objectives.map(({ taskContract }, index) => ({
    task_id: taskContract.task_id,
    contract_id: taskContract.contract_id,
    contract_hash: taskContract.contract_hash,
    attempt_id: `fixture-attempt-${index}`,
    turn_id: `fixture-turn-${index}`,
    submission_event_id: `fixture-submission-${index}`,
    admission_event_id: `fixture-admission-${index}`,
    input_digest: 'a'.repeat(64),
  }))
  const current = objectives.at(-1)!
  const lifecycle: TaskObjectiveLifecycleV1 = {
    schema_version: 1,
    active_task_id: current.taskContract.task_id,
    objectives,
    attempts,
  }
  assert.doesNotThrow(() => assertObjectiveLifecycle(current, lifecycle))
})

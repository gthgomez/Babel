import { collectImplementationCompletenessViolations } from '../src/pipeline.js';
import { SwePlanSchema } from '../src/schemas/agentContracts.js';
import { classifyTaskContract } from '../src/taskCompletion.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const taskContract = classifyTaskContract(
    'Fix and improve the UI of the existing Next.js app landing page and dashboard overview without changing backend contracts.',
  );
  assert(
    taskContract.implementationRequested,
    'expected "improve the UI of the existing Next.js app" to classify as an implementation request',
  );

  const readOnlyImplementationPlan = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Improve the frontend UI.',
    known_facts: ['Frontend files exist.'],
    assumptions: ['At least one page will need edits.'],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Read the landing page file.',
        tool: 'file_read',
        target: 'audit-frontend/src/app/page.tsx',
        rationale: 'Inspect current UI.',
        reversible: true,
        verification: 'The file content is visible.',
      },
    ],
    root_cause: 'N/A — feature request',
    out_of_scope: [],
  });

  const readOnlyReject = collectImplementationCompletenessViolations(
    readOnlyImplementationPlan,
    taskContract,
  );
  assert(readOnlyReject !== null, 'expected implementation completeness rejection for read-only implementation plan');
  assert(
    readOnlyReject.failures[0]?.condition.includes('[IMPLEMENTATION_COMPLETENESS]'),
    'expected implementation completeness failure tag in rejection condition',
  );

  const writableImplementationPlan = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Improve the frontend UI.',
    known_facts: ['Frontend files exist.'],
    assumptions: ['At least one page will need edits.'],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Update the landing page.',
        tool: 'file_write',
        target: 'audit-frontend/src/app/page.tsx',
        rationale: 'Apply the requested UI improvements.',
        reversible: true,
        verification: 'The file is updated with the new UI content.',
      },
    ],
    root_cause: 'N/A — feature request',
    out_of_scope: [],
  });

  const writableReject = collectImplementationCompletenessViolations(
    writableImplementationPlan,
    taskContract,
  );
  assert(writableReject === null, 'expected no implementation completeness rejection when file_write is present');

  console.log('implementation completeness regression test passed');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

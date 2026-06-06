import {
  resolveBabelCliEntry,
  runLiteWorkerLoopHarness,
} from '../src/services/liteWorkerLoop.js';

async function main(): Promise<void> {
  const result = await runLiteWorkerLoopHarness({
    cliEntry: resolveBabelCliEntry(),
  });
  const lines = [
    'Babel Lite Worker Loop (CLI path)',
    `Status: ${result.status}`,
    `Execution mode: ${result.execution_mode}`,
    '',
    ...result.steps.map(step => `${step.status.toUpperCase().padEnd(4)} ${step.name}: ${step.detail}`),
  ];
  console.log(lines.join('\n'));
  if (result.status !== 'pass') {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

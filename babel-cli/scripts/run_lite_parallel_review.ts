import { runLiteParallelReviewHarness } from '../src/services/liteParallelReview.js';

async function main(): Promise<void> {
  const result = await runLiteParallelReviewHarness();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass') {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

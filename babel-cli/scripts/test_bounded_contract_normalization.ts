import {
  extractRequestedFileTargets,
  normalizeRequestedFileTargetsForBoundedContract,
} from '../src/stages/taskShape.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const task = [
    'Replace the placeholder file at',
    'C:\\MockWorkspace\\App-test-Babel\\app\\src\\main\\java\\com\\example\\app\\processing\\MissingFeature.kt',
    'and keep MissingFeature.kt as a real Kotlin source file.',
  ].join(' ');

  const rawTargets = extractRequestedFileTargets(task);
  assert(rawTargets.length === 2, 'expected the raw task text to expose both path mentions');

  const normalizedTargets = normalizeRequestedFileTargetsForBoundedContract(task);
  assert(normalizedTargets.length === 1, 'expected bounded-contract normalization to collapse basename duplicates');
  assert(
    normalizedTargets[0] === 'C:/MockWorkspace/App-test-Babel/app/src/main/java/com/example/app/processing/MissingFeature.kt',
    'expected the canonical requested target to be the full file path',
  );

  console.log('bounded contract normalization regression test passed');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

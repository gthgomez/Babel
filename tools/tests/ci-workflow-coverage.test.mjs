import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { commandCoverage, parseWorkflow } from '../ci-workflow-coverage.mjs';

const workflow = parseWorkflow(readFileSync(new URL('../../.github/workflows/typecheck.yml', import.meta.url), 'utf8'));
const command = 'npm run test:harness-acceptance';
test('matrix commands establish required Linux and Windows dependency coverage', () => {
  assert.deepEqual(commandCoverage(workflow, command), {
    'ubuntu-latest': ['platform-core'], 'windows-latest': ['platform-core'],
  });
});
for (const [label, change] of [
  ['missing Windows', w => { w.jobs['platform-core'].strategy.matrix.os = ['ubuntu-latest']; }],
  ['excluded Windows', w => { w.jobs['platform-core'].strategy.matrix.exclude = [{ os: 'windows-latest' }]; }],
  ['conditional provider', w => { w.jobs['platform-core'].if = 'false'; }],
  ['conditional command', w => { w.jobs['platform-core'].steps.find(s => s.run?.includes(command)).if = 'false'; }],
  ['tolerated command failure', w => { w.jobs['platform-core'].steps.find(s => s.run?.includes(command))['continue-on-error'] = true; }],
  ['missing Windows gate dependency', w => { w.jobs['windows-portability'].needs = w.jobs['windows-portability'].needs.filter(n => n !== 'platform-core'); }],
  ['missing command', w => { w.jobs['platform-core'].steps = w.jobs['platform-core'].steps.filter(s => !s.run?.includes(command)); }],
  ['comment-only command', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `# ${command}`; }],
  ['quoted command data', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `Write-Output '${command}'`; }],
  ['unreachable command', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `if ($false) {\n  ${command}\n}`; }],
  ['different script with shared prefix', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `${command}-different`; }],
  ['early exit before command', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `exit $LASTEXITCODE\n${command}`; }],
  ['skippable aggregate', w => { delete w.jobs['windows-portability'].if; }],
  ['missing dependency guard', w => { w.jobs['linux-validation'].steps = []; }],
]) {
  test(`${label} fails closed`, () => {
    const changed = structuredClone(workflow);
    change(changed);
    assert.throws(() => commandCoverage(changed, command));
  });
}

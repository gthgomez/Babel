// License: Apache-2.0
// Source-runtime integration only; installed GUI acceptance is a separate claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {PrivateWorkerRun} from '../../native/private-worker-run.mjs';
import {saveProviderRoute, applyProviderRoute} from '../../native/provider-routing.mjs';
import {bundledEnvironment} from '../../native/runtime.mjs';
import {assertReadOnlyDenial, buildPackagedLaunchEnvironment, writePackagedAcceptanceProfile} from './packaged-fixture-lane.mjs';
import {assertRepairBaseline, assertRepairComplete} from './packaged-repair-fixture.mjs';
import {startScriptedProvider} from './scripted-provider.mjs';

const workerEntry = fileURLToPath(new URL('../../../babel-cli/dist/protocol/privateWorkerMain.js', import.meta.url));
const projectKey = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

async function turn(worker, project, runId, task) {
  const events = [];
  let unexpectedApproval = false;
  const result = await new Promise((done, reject) => {
    const timeout = setTimeout(() => { worker.cancel(); reject(new Error('fixture turn timed out')); }, 90_000);
    worker.start({runId, task, mode: 'chat', executionScope: {kind: 'project', projectRoot: project}}, packet => {
      if (packet.kind === 'event') {
        events.push(packet.event);
        if (packet.event?.type === 'approval.required') {
          const item = packet.event.item;
          if (item?.command === 'npm test' && typeof item.cwd === 'string' && projectKey(item.cwd) === projectKey(project)) {
            worker.reply({runId, decision: 'allow_once', approval: item.approval});
          } else { unexpectedApproval = true; worker.cancel(); }
        }
      }
      if (packet.kind === 'exit') { clearTimeout(timeout); done(packet.code); }
    }).catch(error => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(unexpectedApproval, false, 'only the fixture verifier may be approved');
  assert.equal(result, 0);
  return events;
}

test('real source worker denies the read-only edit and completes the independently verified repair', {timeout: 180_000}, async () => {
  assert.ok(existsSync(workerEntry), 'build babel-cli before this source-runtime test');
  const root = await mkdtemp(join(tmpdir(), 'babel-scripted-worker-'));
  let provider, worker;
  try {
    const fixture = await writePackagedAcceptanceProfile(root);
    const configDirectory = join(root, 'engine', 'config');
    saveProviderRoute({configDirectory, provider: 'ollama', model: 'ollama/local-fixture'});
    const env = applyProviderRoute(bundledEnvironment(root, buildPackagedLaunchEnvironment(process.env, root)), configDirectory);
    provider = await startScriptedProvider();
    worker = new PrivateWorkerRun({executable: process.execPath, entry: workerEntry, projectRoot: fixture.projectRoot,
      provider: 'ollama', providerModelId: 'local-fixture', model: 'ollama/local-fixture', env, inheritEnv: false});

    await assertRepairBaseline(fixture.projectRoot);
    provider.selectScenario('readOnly');
    const inspected = await turn(worker, fixture.projectRoot, 'fixture-read-only', 'Review parser.mjs and explain its defect. Do not modify files.');
    assertReadOnlyDenial(inspected.map(event => ({type: event.type, tool: event.item?.tool, detail: event.item?.detail})));
    assert.ok(inspected.some(event => event.type === 'run_complete' && event.result?.terminal_outcome === 'NO_CHANGE_REQUIRED'));
    assert.equal(inspected.find(event => event.type === 'run_complete')?.result?.user_status, 'completed');
    await provider.waitForCounts(3, 0);
    assert.deepEqual(provider.snapshot(), {scenario: 'readOnly', calls: 3, rejected: 0});
    await assertRepairBaseline(fixture.projectRoot);

    provider.selectScenario('repair');
    const repaired = await turn(worker, fixture.projectRoot, 'fixture-repair',
      'Investigate why parser_test fails and fix it.\nRequirements:\n- `npm test` passes.');
    assert.ok(repaired.some(event => event.type === 'run_complete' && event.result?.terminal_outcome === 'VERIFIED_COMPLETE'));
    assert.equal(repaired.find(event => event.type === 'run_complete')?.result?.user_status, 'completed');
    await provider.waitForCounts(5, 0);
    assert.deepEqual(provider.snapshot(), {scenario: 'repair', calls: 5, rejected: 0});
    const independent = await assertRepairComplete(fixture.projectRoot);
    assert.equal(independent.testExit, 0);
    assert.deepEqual(independent.diff, {path: 'parser.mjs', additions: 1, deletions: 1});
  } finally {
    if (worker) await worker.shutdown();
    if (provider) await provider.close();
    await rm(root, {recursive: true, force: true});
  }
});

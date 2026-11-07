import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs';

test('Desktop streaming Plan uses the canonical read-only plan lane even with automatic application saved',async()=>{
  const fixture=prepareSyntheticProviderFixture();
  try{
    writeFileSync(join(fixture.cwd,'calc.js'),'export const value=1;\n');
    writeFileSync(join(fixture.root,'state','preferences.json'),JSON.stringify({schemaVersion:1,connections:{},defaults:{plans:{autoApply:true},budgetUsd:'unlimited'}}));
    const preload=join(fixture.root,'desktop-plan.mjs');
    writeFileSync(preload,"process.env.BABEL_DESKTOP_IPC='1';process.env.BABEL_LITE_OFFLINE='1';process.env.BABEL_OFFLINE='1';process.env.BABEL_PIPELINE_V9_OFFLINE='1';");
    const child=spawnSync(process.execPath,[
      '--experimental-wasm-modules','--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
      '--import',import.meta.resolve('tsx'),'--import',pathToFileURL(preload).href,fileURLToPath(new URL('../index.ts',import.meta.url)),
      'run','--mode','plan','--model','glm-5.3-flash','--output-format','stream-json','--project-root',fixture.cwd,'--',
      'Inspect calc.js and plan a validation change. Do not modify any files.',
    ],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(child.error,undefined);
    assert.equal(child.status,0,child.stderr.slice(-1000));
    const events=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
    const result=events.find(event=>event.type==='run_complete')?.result;
    assert.ok(events.some(event=>event.type==='tool.started'),'actual read-only discovery activity reaches the stream');
    assert.ok(events.some(event=>event.type==='tool.completed'));
    assert.equal(result?.status,'PLAN_READY');
    assert.equal(result.command,'plan');
    assert.equal(typeof result.plan_id,'string');
    assert.equal(result.apply_available, false);
    assert.match(result.apply_unavailable_reason, /temporarily unavailable/i);
    const { loadSavedPlan } = await import('../services/savedPlan.js');
    const saved = loadSavedPlan(result.plan_id, { BABEL_STATE_DIR: join(fixture.root, 'state') });
    assert.ok(saved.sourceRunId); assert.equal(saved.sourceRunId, basename(result.run_dir));
    assert.equal(saved.body, readFileSync(join(result.run_dir, 'plan.md'), 'utf8').trim());
    const contract = JSON.parse(readFileSync(join(result.run_dir, 'contract.json'), 'utf8'));
    assert.equal(contract.schema_version, 1); assert.equal(contract.mode, 'babel-lite-plan');
    const { loadPlanHandoff } = await import('../agent/planHandoff.js');
    const previousRuns = process.env['BABEL_RUNS_DIR']; process.env['BABEL_RUNS_DIR'] = join(fixture.root, 'runs');
    try {
      const handoff = loadPlanHandoff({ repoPath: fixture.cwd, task: 'Inspect calc.js and plan a validation change.', planRunId: saved.sourceRunId });
      assert.ok(handoff); assert.equal(handoff.contract?.mode, 'babel-lite-plan');
      assert.ok(handoff.allowedPaths.includes('calc.js'), 'persisted handoff retains the target scope');
    } finally { if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = previousRuns; }
    assert.match(result.answer.answer,/Steps:|plan/i);
    assert.deepEqual(result.changed_files,[]);
    assert.equal(readFileSync(join(fixture.cwd,'calc.js'),'utf8'),'export const value=1;\n');
    assert.doesNotMatch(child.stdout+child.stderr,/Automatic application enabled|MANUAL_BRIDGE_REQUIRED/);
  }finally{removeSyntheticProviderFixture(fixture.root);}
});

test('CLI Apply preserves a valid Plan when scoped mutation is unavailable', async () => {
  const fixture = prepareSyntheticProviderFixture();
  try {
    const { savePlan, loadSavedPlan } = await import('../services/savedPlan.js');
    const id = '20260610T180000Z-plan-abcdef01'; const source = join(fixture.cwd, 'runs', 'babel-lite', id);
    mkdirSync(source, { recursive: true }); writeFileSync(join(fixture.cwd, 'fixture.js'), 'original fixture\n');
    writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Plan' }));
    writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['fixture.js'], required_reads: [] }));
    writeFileSync(join(source, 'plan.md'), 'Update fixture.js.');
    const env = { ...fixture.env, BABEL_LIVE: '1' };
    const plan = savePlan({ projectRoot: fixture.cwd, task: 'Update fixture.js', body: 'Update fixture.js.', sourceRunId: id }, env);
    const marker = join(fixture.root, 'unexpected-dispatch'); const preload = join(fixture.root, 'apply-valid-fixture.mjs');
    writeFileSync(preload, `import { writeFileSync } from 'node:fs'; globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, 'called'); throw new Error('unexpected dispatch'); };`);
    const child = spawnSync(process.execPath, ['--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href, '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../index.ts', import.meta.url)), 'apply', '--plan', plan.id], { cwd: fixture.cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined); assert.notEqual(child.status, 0); assert.match(child.stdout + child.stderr, /Plan application is temporarily unavailable/i);
    assert.equal(loadSavedPlan(plan.id, env).state, 'ready'); assert.equal(readFileSync(join(fixture.cwd, 'fixture.js'), 'utf8'), 'original fixture\n'); assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  } finally { removeSyntheticProviderFixture(fixture.root); }
});

test('CLI apply refuses an unavailable saved Plan source before inference', async () => {
  const fixture = prepareSyntheticProviderFixture();
  try {
    const { savePlan } = await import('../services/savedPlan.js');
    const { updateUserSettings } = await import('../config/userSettings.js');
    const env = { BABEL_STATE_DIR: join(fixture.root, 'state'), BABEL_CONFIG_DIR: join(fixture.root, 'config') };
    updateUserSettings({ connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } }, defaults: { connection: 'fixture', budgetUsd: 'unlimited' } }, { env });
    const plan = savePlan({ projectRoot: fixture.cwd, task: 'Inspect README', body: 'Inspect README', sourceRunId: '20260610T180000Z-plan-abcdef01' }, env);
    const marker = join(fixture.root, 'dispatch-marker');
    const preload = join(fixture.root, 'apply-fixture.mjs');
    writeFileSync(preload, `import { writeFileSync } from 'node:fs'; process.env.BABEL_OPENCLAW_APPROVED_ROOTS = ${JSON.stringify(fixture.cwd)}; globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, 'called'); throw new Error('synthetic dispatch'); };`);
    const child = spawnSync(process.execPath, [
      '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../index.ts', import.meta.url)), 'apply', '--plan', plan.id,
    ], { cwd: fixture.cwd, env: { ...fixture.env, BABEL_LIVE: '1' }, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0);
    assert.match(child.stdout + child.stderr, /saved plan source is unavailable/i);
    assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  } finally { removeSyntheticProviderFixture(fixture.root); }
});

test('CLI legacy manual Plan apply rejects without changing the retained file', () => {
  const fixture = prepareSyntheticProviderFixture()
  try {
    const plan = join(fixture.cwd, 'manual-plan.json'); const original = '{"synthetic":"retained"}\n'; writeFileSync(plan, original)
    const child = spawnSync(process.execPath, [
      '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../index.ts', import.meta.url)),
      'apply', '--run', fixture.cwd, '--plan', plan,
    ], { cwd: fixture.cwd, env: fixture.env, encoding: 'utf8', timeout: 120000, windowsHide: true })
    assert.equal(child.error, undefined); assert.notEqual(child.status, 0)
    assert.match(child.stdout + child.stderr, /UNSUPPORTED_OPERATION.*legacy.*resume/i)
    assert.equal(readFileSync(plan, 'utf8'), original)
  } finally { removeSyntheticProviderFixture(fixture.root) }
})

test('CLI Apply retains a sensitive Plan body and makes no provider request', async () => {
  const fixture = prepareSyntheticProviderFixture()
  try {
    const { savePlan, loadSavedPlan } = await import('../services/savedPlan.js')
    const { updateUserSettings } = await import('../config/userSettings.js')
    const env = { BABEL_STATE_DIR: join(fixture.root, 'state'), BABEL_CONFIG_DIR: join(fixture.root, 'config') }
    updateUserSettings({ connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } }, defaults: { connection: 'fixture', budgetUsd: 'unlimited' } }, { env })
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(fixture.cwd, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe fixture summary' }))
    writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: [], required_reads: [] }))
    const body = 'OPENAI_API_KEY=SYNTHETIC_PLAN_BODY_SECRET'; writeFileSync(join(source, 'plan.md'), body)
    const plan = savePlan({ projectRoot: fixture.cwd, task: 'Implement fixture', body, sourceRunId }, env)
    const marker = join(fixture.root, 'dispatch-marker'); const preload = join(fixture.root, 'apply-private-fixture.mjs')
    writeFileSync(preload, `import { writeFileSync } from 'node:fs'; process.env.BABEL_OPENCLAW_APPROVED_ROOTS = ${JSON.stringify(fixture.cwd)}; globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, 'called'); throw new Error('synthetic dispatch'); };`)
    const child = spawnSync(process.execPath, [ '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href, '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../index.ts', import.meta.url)), 'apply', '--plan', plan.id ], { cwd: fixture.cwd, env: { ...fixture.env, BABEL_LIVE: '1' }, encoding: 'utf8', timeout: 120000, windowsHide: true })
    assert.equal(child.error, undefined); assert.notEqual(child.status, 0)
    assert.match(child.stdout + child.stderr, /credential-shaped/i)
    assert.equal((child.stdout + child.stderr).includes('SYNTHETIC_PLAN_BODY_SECRET'), false)
    assert.throws(() => readFileSync(marker), { code: 'ENOENT' })
    assert.equal(loadSavedPlan(plan.id, env).body, body); assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { removeSyntheticProviderFixture(fixture.root) }
})

test('CLI Apply retains sensitive task metadata and makes no provider request', async () => {
  const fixture = prepareSyntheticProviderFixture()
  try {
    const { savePlan, loadSavedPlan } = await import('../services/savedPlan.js')
    const { updateUserSettings } = await import('../config/userSettings.js')
    const env = { BABEL_STATE_DIR: join(fixture.root, 'state'), BABEL_CONFIG_DIR: join(fixture.root, 'config') }
    updateUserSettings({ connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } }, defaults: { connection: 'fixture', budgetUsd: 'unlimited' } }, { env })
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(fixture.cwd, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe fixture summary' })); writeFileSync(join(source, 'plan.md'), 'Safe plan')
    writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: [], required_reads: [] }))
    const task = 'Implement with OPENAI_API_KEY=SYNTHETIC_PLAN_TASK_SECRET'; const plan = savePlan({ projectRoot: fixture.cwd, task, body: 'Safe plan', sourceRunId }, env)
    const marker = join(fixture.root, 'dispatch-marker'); const preload = join(fixture.root, 'apply-task-private-fixture.mjs')
    writeFileSync(preload, `import { writeFileSync } from 'node:fs'; process.env.BABEL_OPENCLAW_APPROVED_ROOTS = ${JSON.stringify(fixture.cwd)}; globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, 'called'); throw new Error('synthetic dispatch'); };`)
    const child = spawnSync(process.execPath, [ '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href, '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../index.ts', import.meta.url)), 'apply', '--plan', plan.id ], { cwd: fixture.cwd, env: { ...fixture.env, BABEL_LIVE: '1' }, encoding: 'utf8', timeout: 120000, windowsHide: true })
    assert.equal(child.error, undefined); assert.notEqual(child.status, 0); assert.match(child.stdout + child.stderr, /credential-shaped/i)
    assert.equal((child.stdout + child.stderr).includes('SYNTHETIC_PLAN_TASK_SECRET'), false); assert.throws(() => readFileSync(marker), { code: 'ENOENT' })
    assert.equal(loadSavedPlan(plan.id, env).task, task); assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { removeSyntheticProviderFixture(fixture.root) }
})

test('Desktop Plan returns retained useful work when canonical saving is unavailable', () => {
  const fixture = prepareSyntheticProviderFixture();
  try {
    writeFileSync(join(fixture.cwd, 'calc.js'), 'export const value=1;\n');
    const preload = join(fixture.root, 'desktop-plan-partial.mjs');
    writeFileSync(preload, "process.env.BABEL_DESKTOP_IPC='1';process.env.BABEL_LITE_OFFLINE='1';process.env.BABEL_OFFLINE='1';process.env.BABEL_PIPELINE_V9_OFFLINE='1';");
    const child = spawnSync(process.execPath, [
      '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../index.ts', import.meta.url)),
      'run', '--mode', 'plan', '--model', 'glm-5.3-flash', '--output-format', 'stream-json', '--project-root', fixture.cwd, '--',
      'Inspect calc.js and plan a validation change. Do not modify any files.',
    ], { cwd: fixture.cwd, env: fixture.env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined); assert.equal(child.status, 1, `${child.stdout.slice(-2000)}\n${child.stderr.slice(-1000)}`);
    const events = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    const result = events.find(event => event.type === 'run_complete')?.result;
    assert.equal(result?.status, 'PLAN_READY'); assert.equal(result?.user_status, 'blocked'); assert.equal(result?.plan_saved, false); assert.equal(result?.apply_available, false)
    assert.equal(result?.plan_id, undefined); assert.match(result?.apply_unavailable_reason ?? '', /temporarily unavailable/i)
    assert.match(result?.answer?.answer ?? '', /Steps:|plan/i); assert.equal(readFileSync(join(fixture.cwd, 'calc.js'), 'utf8'), 'export const value=1;\n');
  } finally { removeSyntheticProviderFixture(fixture.root); }
});

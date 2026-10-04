import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { OpenCodeGoBudget } from './openCodeGoBudget.js'
import { OpenCodeGoApiRunner } from './openCodeGoApi.js'

const windows = { skip: process.platform !== 'win32' ? 'Native Windows SQLite boundary' : false }
const moduleUrl = new URL('./openCodeGoBudget.ts', import.meta.url).href
const require = createRequire(import.meta.url)
const childImports = ['--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
  '--import', pathToFileURL(require.resolve('tsx')).href, '--input-type=module', '--eval']

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'babel-windows-go-ledger-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, statePath: join(root, 'budget.json'), jobId: 'owner', limitUsd: 0.00001 }
}

function state(path: string): { reservedNanoUsd: number; attempts: number; limitNanoUsd: number; grantRevision?: number } {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return JSON.parse(String(db.prepare('SELECT payload FROM go_reservation WHERE id = 1').get()!.payload)) }
  finally { db.close() }
}

async function child(script: string, barrier = false) {
  const processChild = spawn(process.execPath, [...childImports, script], {
    windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let reached!: () => void
  const observed = new Promise<void>(resolve => { reached = resolve })
  const settled = new Promise<number>(resolve => {
    processChild.once('error', () => resolve(1))
    processChild.once('close', code => resolve(code ?? 1))
  })
  processChild.stdout.on('data', chunk => { output += String(chunk); if (output.includes('BARRIER\n')) reached() })
  processChild.stderr.resume()
  if (barrier) {
    const timer = setTimeout(() => { processChild.kill(); }, 10_000)
    try {
      await Promise.race([observed, settled.then(() => { throw Error('Child settled before the observed barrier') })])
      processChild.kill()
      await settled
    } finally { clearTimeout(timer); if (processChild.exitCode === null) processChild.kill() }
  }
  return { code: await settled, output }
}

test('Windows Go reservations commit before transport and remain debited after unknown usage', windows, async t => {
  const options = fixture(t)
  options.limitUsd = 2
  let calls = 0
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = (async () => {
    calls++
    assert.equal(state(options.statePath).attempts, calls, 'committed reservation precedes fetch')
    return new Response(JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ message: { content: 'ok' } }] }))
  }) as typeof fetch
  const runner = new OpenCodeGoApiRunner('deepseek-v4.1-flash', { maxTokens: 16 }, {
    budget: new OpenCodeGoBudget(options), credentialSource: 'explicit-test', explicitCredential: 'synthetic-go',
  })
  await runner.executeRaw('one')
  await runner.executeRaw('two')
  assert.equal(calls, 2)
  assert.equal(state(options.statePath).attempts, 2)
  assert.ok(state(options.statePath).reservedNanoUsd > 0)
  assert.equal(runner.getLastInvocationMetadata()?.total_tokens, null)
})

test('Windows Go denies deleted, corrupt, moved, wrong-owner and reduced or stale grant state', windows, async t => {
  const options = fixture(t)
  let grant = { grantId: 'g0', revision: 0, limitUsd: options.limitUsd }
  const budget = new OpenCodeGoBudget({ ...options, currentGrant: () => grant })
  await budget.reserve(1, 1)
  grant = { grantId: 'g1', revision: 1, limitUsd: 0.00002 }
  await budget.reserve(1, 1)
  assert.equal(state(options.statePath).reservedNanoUsd, 3000)
  assert.equal(state(options.statePath).grantRevision, 1)
  const resumed = new OpenCodeGoBudget({ ...options, requireExistingState: true, currentGrant: () => grant })
  await resumed.reserve(1, 1)
  assert.equal(state(options.statePath).reservedNanoUsd, 4500)
  for (const input of [
    { ...options, jobId: 'other' },
    { ...options, currentGrant: () => ({ grantId: 'g0', revision: 0, limitUsd: options.limitUsd }) },
    { ...options, currentGrant: () => ({ grantId: 'g2', revision: 2, limitUsd: 0.000001 }) },
    { ...options, currentGrant: () => grant, currentLimitUsd: () => 0.000001 },
  ]) await assert.rejects(new OpenCodeGoBudget(input).reserve(1, 1), /budget denied/i)
  const moved = join(options.root, 'moved.json')
  copyFileSync(options.statePath, moved)
  await assert.rejects(new OpenCodeGoBudget({ ...options, statePath: moved, currentGrant: () => grant }).reserve(1, 1), /budget denied/i)
  writeFileSync(options.statePath, 'corrupt')
  await assert.rejects(resumed.reserve(1, 1), /budget denied/i)
  rmSync(options.statePath)
  await assert.rejects(resumed.reserve(1, 1), /budget denied/i)
  await assert.rejects(new OpenCodeGoBudget({ ...options, requireExistingState: true }).reserve(1, 1), /budget denied/i)
  assert.equal(existsSync(options.statePath), false)
})

test('Windows Go migrates validated legacy bytes once without resetting reservations', windows, async t => {
  const options = fixture(t)
  const legacy = JSON.stringify({ schema: 1, jobId: options.jobId, limitNanoUsd: 10000, reservedNanoUsd: 1500, attempts: 1 })
  writeFileSync(options.statePath, legacy)
  await new OpenCodeGoBudget({ ...options, requireExistingState: true }).reserve(1, 1)
  assert.equal(readFileSync(`${options.statePath}.legacy.json`, 'utf8'), legacy)
  assert.equal(state(options.statePath).reservedNanoUsd, 3000)
  assert.equal(state(options.statePath).attempts, 2)
  rmSync(options.statePath)
  await assert.rejects(new OpenCodeGoBudget(options).reserve(1, 1), /budget denied/i)
  assert.equal(readFileSync(`${options.statePath}.legacy.json`, 'utf8'), legacy)
})

test('Windows Go survives real process deaths before commit, after commit and after an effect', windows, async t => {
  for (const stage of ['before_commit', 'after_commit', 'after_effect']) {
    const options = fixture(t)
    await new OpenCodeGoBudget(options).reserve(1, 1)
    const effect = join(options.root, 'effect.txt')
    const barrierCode = `import { writeSync, appendFileSync } from 'node:fs';
      const barrier = () => { writeSync(1, 'BARRIER\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); };
      import { DatabaseSync } from 'node:sqlite';
      const original = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if (${JSON.stringify(stage)} === 'before_commit' && sql === 'COMMIT') barrier();
        const result = original.call(this, sql);
        if (${JSON.stringify(stage)} === 'after_commit' && sql === 'COMMIT') barrier();
        return result;
      };
      import { OpenCodeGoBudget } from ${JSON.stringify(moduleUrl)};
      await new OpenCodeGoBudget(${JSON.stringify({ ...options, requireExistingState: true })}).reserve(1,1);
      appendFileSync(${JSON.stringify(effect)}, 'once\\n'); barrier();`
    await child(barrierCode, true)
    const retained = state(options.statePath)
    assert.equal(retained.reservedNanoUsd, stage === 'before_commit' ? 1500 : 3000)
    assert.equal(retained.attempts, stage === 'before_commit' ? 1 : 2)
    new OpenCodeGoBudget({ ...options, requireExistingState: true }).assertCurrentAuthority()
    await new OpenCodeGoBudget({ ...options, requireExistingState: true }).reserve(1, 1)
    assert.equal(state(options.statePath).reservedNanoUsd, retained.reservedNanoUsd + 1500)
    assert.equal(existsSync(effect), stage === 'after_effect')
    if (stage === 'after_effect') assert.equal(readFileSync(effect, 'utf8'), 'once\n')
  }
})

test('Windows Go process contention cannot exceed the shared cap', windows, async t => {
  const options = fixture(t)
  options.limitUsd = 0.000002
  const script = `import { OpenCodeGoBudget } from ${JSON.stringify(moduleUrl)};
    await new OpenCodeGoBudget(${JSON.stringify(options)}).reserve(1,1);`
  const results = await Promise.all(Array.from({ length: 4 }, () => child(script)))
  assert.equal(results.filter(result => result.code === 0).length, 1)
  assert.equal(state(options.statePath).reservedNanoUsd, 1500)
  assert.equal(state(options.statePath).attempts, 1)
})

test('Windows Go interrupted migration retains legacy evidence and refuses reinitialization', windows, async t => {
  for (const stage of ['commit', 'promotion']) {
  const options = fixture(t)
  const legacy = JSON.stringify({ schema: 1, jobId: options.jobId, limitNanoUsd: 10000, reservedNanoUsd: 1500, attempts: 1 })
  writeFileSync(options.statePath, legacy)
  const script = `import { DatabaseSync } from 'node:sqlite'; import fs, { writeSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const barrier = () => { writeSync(1, 'BARRIER\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); };
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (${JSON.stringify(stage)} === 'commit' && sql === 'COMMIT') barrier();
      return original.call(this, sql);
    };
    const originalRename = fs.renameSync;
    fs.renameSync = function(from, to) {
      const result = originalRename(from, to);
      if (${JSON.stringify(stage)} === 'promotion' && from === ${JSON.stringify(options.statePath)}) barrier();
      return result;
    };
    syncBuiltinESMExports();
    import { OpenCodeGoBudget } from ${JSON.stringify(moduleUrl)};
    await new OpenCodeGoBudget(${JSON.stringify({ ...options, requireExistingState: true })}).reserve(1,1);`
  await child(script, true)
  assert.equal(readFileSync(stage === 'commit' ? options.statePath : `${options.statePath}.legacy.json`, 'utf8'), legacy)
  await assert.rejects(new OpenCodeGoBudget(options).reserve(1, 1), /budget denied/i)
  }
})

test('Windows Go death during first-store creation cannot become an empty resume budget', windows, async t => {
  const options = fixture(t)
  const script = `import { DatabaseSync } from 'node:sqlite'; import { writeSync } from 'node:fs';
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'COMMIT') { writeSync(1, 'BARRIER\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); }
      return original.call(this, sql);
    };
    import { OpenCodeGoBudget } from ${JSON.stringify(moduleUrl)};
    await new OpenCodeGoBudget(${JSON.stringify(options)}).reserve(1,1);`
  await child(script, true)
  assert.equal(existsSync(options.statePath), true)
  await assert.rejects(new OpenCodeGoBudget({ ...options, requireExistingState: true }).reserve(1, 1), /budget denied/i)
  await assert.rejects(new OpenCodeGoBudget(options).reserve(1, 1), /budget denied/i)
})

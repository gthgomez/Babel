import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture,
} from '../testinfra/synthetic-provider-fixture.mjs'
import {
  recoverCheckpointArtifacts,
  loadLiveSessionAuthorityStrict,
} from './liveSessionBridge.js'

for (const change of ['replace', 'amend'] as const) test(
  `actual process kills retain one ${change} objective and allowance generation`,
  { timeout: 240000 },
  async () => {
    const require = createRequire(import.meta.url)
    const initialRequest = 'Explain fixture A.\nRequirements:\n- Preserve its public API.'
    const nextRequest = change === 'replace' ? 'Explain fixture B' : 'Also require:\n- Survive restart.'
    for (const phase of [
      'prepare',
      'partial',
      'history',
      'lifecycle',
      'budget',
      'commit',
    ]) {
      const fixture = prepareSyntheticProviderFixture(),
        ready = join(fixture.root, 'ready'),
        beforePath = join(fixture.root, 'before.json'),
        nextPath = join(fixture.root, 'next.json')
      const runDir = join(
          fixture.env.BABEL_RUNS_DIR,
          'chat-sessions',
          'objective-crash',
        ),
        driver = join(fixture.root, 'objective-crash.mjs')
      let child: ReturnType<typeof spawn> | undefined,
        closed: Promise<number | null> | undefined
      try {
        writeFileSync(
          driver,
          `
import fs from 'node:fs';
import {join,basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const {ChatEngine}=await import(${JSON.stringify(new URL('./chatEngine.ts', import.meta.url).href)});
const engine=new ChatEngine({model:'deepseek-v4-flash-openrouter',task:${JSON.stringify(initialRequest)},projectRoot:${JSON.stringify(fixture.cwd)},runId:'objective-crash'});
const route={model:'fixture-model',provider:'ollama'};
engine.admitUserSubmission({userInput:${JSON.stringify(initialRequest)}},route);
const allowance=engine.getTaskAllowanceSnapshot();
if(${JSON.stringify(change)}==='replace')engine.ownerAccounting.recordOwnerAccountingFault({taskOwnerId:allowance.taskOwnerId,accountingEpoch:allowance.accountingEpoch,chargeId:'fixture-failed-charge',ownerGeneration:1},'persistence-failure','Fixture receipt persistence unavailable',true);
const runDir=${JSON.stringify(runDir)},phase=${JSON.stringify(phase)};
fs.writeFileSync(${JSON.stringify(beforePath)},JSON.stringify(fs.readdirSync(runDir).filter(name=>fs.lstatSync(join(runDir,name)).isFile()).map(filename=>({filename,bytes:fs.readFileSync(join(runDir,filename),'utf8')}))));
const originalRename=fs.renameSync,originalWrite=fs.writeFileSync;
const park=()=>{originalWrite(${JSON.stringify(ready)},phase);for(;;)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);};
let primaryRenames=0;
fs.renameSync=function(source,destination){
  const result=originalRename(source,destination),name=basename(String(destination));
  if(name==='live-session-checkpoint.journal.json'){
    const journal=JSON.parse(fs.readFileSync(destination,'utf8'));
    if(phase==='prepare'&&journal.status==='prepared'&&!journal.backups_ready)park();
    if(journal.status==='prepared'&&journal.backups_ready)originalWrite(${JSON.stringify(nextPath)},JSON.stringify(journal.targets.map(filename=>({filename,bytes:fs.readFileSync(join(runDir,filename+'.'+journal.batch_id+'.tmp'),'utf8')}))));
    if(phase==='commit'&&journal.status==='committed')park();
  }else{
    primaryRenames++;
    if(phase==='partial'&&primaryRenames===2||phase==='history'&&name==='task-mode-history.json'||phase==='lifecycle'&&name==='task-objective-lifecycle.json'||phase==='budget'&&name==='task-budget.json')park();
  }
  return result;
};syncBuiltinESMExports();
engine.admitUserSubmission({userInput:${JSON.stringify(nextRequest)}},route);
throw new Error('Fixture boundary was not reached');
`,
        )
        child = spawn(
          process.execPath,
          [
            '--import',
            new URL(
              '../testinfra/synthetic-provider-fixture.mjs',
              import.meta.url,
            ).href,
            '--import',
            pathToFileURL(require.resolve('tsx')).href,
            '--import',
            new URL(
              '../testinfra/register-no-ambient-inference.mjs',
              import.meta.url,
            ).href,
            driver,
          ],
          {
            env: fixture.env,
            cwd: fixture.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        )
        // Drain arbitrary child diagnostics; only fixed scalar assertions escape.
        child.stdout?.resume()
        child.stderr?.resume()
        closed = new Promise((resolve, reject) => {
          child!.once('error', reject)
          child!.once('close', (code) => resolve(code))
        })
        const deadline = Date.now() + 45000
        while (
          !existsSync(ready) &&
          child.exitCode === null &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 25))
        assert.equal(
          existsSync(ready),
          true,
          `${phase} fixture must reach its publication boundary`,
        )
        assert.equal(child.kill('SIGKILL'), true)
        await closed
        recoverCheckpointArtifacts(runDir)
        const before = JSON.parse(readFileSync(beforePath, 'utf8')) as {
          filename: string
          bytes: string
        }[]
        const next =
          phase === 'commit'
            ? (JSON.parse(readFileSync(nextPath, 'utf8')) as {
                filename: string
                bytes: string
              }[])
            : []
        for (const old of before) {
          const expected =
            next.find((value) => value.filename === old.filename)?.bytes ??
            old.bytes
          assert.equal(
            readFileSync(join(runDir, old.filename), 'utf8'),
            expected,
            `${phase} must recover one complete generation`,
          )
        }
        const authority = loadLiveSessionAuthorityStrict(runDir),
          budget = JSON.parse(
            readFileSync(join(runDir, 'task-budget.json'), 'utf8'),
          )
        assert.equal(
          authority.taskContract.user_request,
          phase === 'commit' && change === 'replace' ? nextRequest : initialRequest,
        )
        if (change === 'amend') assert.deepEqual(authority.taskContract.acceptance_criteria, phase === 'commit' ? ['Preserve its public API.', 'Survive restart.'] : ['Preserve its public API.'])
        assert.equal(budget.acceptedTaskId, authority.taskContract.task_id)
        if (change === 'replace') {
          assert.equal(budget.accountingFaults?.length, 1)
          assert.equal(budget.accountingFaults[0].chargeId, 'fixture-failed-charge')
        } else assert.equal(budget.accountingFaults?.length ?? 0, 0)
        assert.equal(
          authority.taskObjectiveLifecycle!.objectives.length,
          phase === 'commit' && change === 'replace' ? 2 : 1,
        )
        assert.equal(
          existsSync(join(runDir, 'live-session-checkpoint.journal.json')),
          false,
        )
        assert.equal(
          readdirSync(runDir).some((name) => /\.(tmp|bak)$/.test(name)),
          false,
        )
      } finally {
        if (child && child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
        if (closed) await closed
        removeSyntheticProviderFixture(fixture.root)
      }
    }
  },
)

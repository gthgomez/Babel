import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isSyntheticProviderFixtureReady, runSyntheticProviderTestFile } from '../testinfra/synthetic-provider-fixture.mjs';

if (!isSyntheticProviderFixtureReady()) {
  test('interactive credentials use an isolated synthetic profile', {timeout:60000}, async t => {
    const result=await runSyntheticProviderTestFile(import.meta.url);t.diagnostic(JSON.stringify(result));
    assert.equal(result.exitCode,0);assert.ok(result.passed>0);
  });
} else {
const { maybePromptForMissingProviderCredential, promptForProviderCredential, readMaskedLine } = await import('./interactiveCredential.js');
const { VirtualTerminal } = await import('../interactive/testing/ptyHarness.js');
const { updateUserSettings } = await import('./userSettings.js');

test('maybePromptForMissingProviderCredential is a no-op for machine output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-interactive-cred-'));
  const env: NodeJS.ProcessEnv = {
    BABEL_CONFIG_DIR: join(root, 'config'),
    OPENROUTER_API_KEY: '',
  };
  delete env.OPENROUTER_API_KEY;
  await maybePromptForMissingProviderCredential(env, ['node', 'babel', 'run', 'hello', '--json']);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('a configured selected connection does not prompt for unrelated providers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-credential-selected-'));
  const env: NodeJS.ProcessEnv = { BABEL_STATE_DIR:root, BABEL_CONFIG_DIR:join(root,'config'), OPENROUTER_API_KEY:'synthetic-existing-key', CI:'0' };
  updateUserSettings({connections:{router:{id:'router',provider:'openrouter',model:'vendor/model'}},defaults:{connection:'router'}},{env});
  const term=new VirtualTerminal({isTTY:true});
  try {
    const pending=maybePromptForMissingProviderCredential(env,['node','babel','run','hello'],{input:term.stdin,output:term.stderr});
    const finished=await Promise.race([pending.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),250))]);
    if(!finished){term.sendLine('');await pending;}
    assert.equal(finished,true);
    assert.equal(term.getRawOutput().includes('Provider env variable'),false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('credential prompting follows the selected project connection and skips offline mode', async () => {
  const root=mkdtempSync(join(tmpdir(),'babel-credential-project-'));
  const env:NodeJS.ProcessEnv={BABEL_STATE_DIR:root,BABEL_CONFIG_DIR:join(root,'config'),COMMAND_CODE_API_KEY:'synthetic-project-key',CI:'0'};
  updateUserSettings({connections:{router:{id:'router',provider:'openrouter',model:'vendor/a'},command:{id:'command',provider:'command-code',model:'vendor/b'}},
    defaults:{connection:'router'},projects:{[root]:{connection:'command'}}},{env});
  try {
    const term=new VirtualTerminal({isTTY:true});
    const pending=maybePromptForMissingProviderCredential(env,['node','babel','run','hello'],{input:term.stdin,output:term.stderr,projectRoot:root});
    const finished=await Promise.race([pending.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),250))]);
    if(!finished){term.sendCtrlC();await pending.catch(()=>{});}
    assert.equal(finished,true,'The project key is present; the unrelated default must not be prompted.');
    delete env.COMMAND_CODE_API_KEY;
    const offline=new VirtualTerminal({isTTY:true});
    const blocked=maybePromptForMissingProviderCredential(env,['node','babel','run','hello','--offline'],{input:offline.stdin,output:offline.stderr,projectRoot:root});
    const offlineFinished=await Promise.race([blocked.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),250))]);
    if(!offlineFinished){offline.sendCtrlC();await blocked.catch(()=>{});}
    assert.equal(offlineFinished,true,'Offline mode must not ask for a cloud key.');
    const repair=new VirtualTerminal({isTTY:true});
    const requested=maybePromptForMissingProviderCredential(env,['node','babel','run','hello'],{input:repair.stdin,output:repair.stderr,projectRoot:root});
    await repair.waitForOutput('Paste API key (masked):',2000);repair.sendLine('synthetic-repaired-project-key');await requested;
    assert.equal(env.COMMAND_CODE_API_KEY,'synthetic-repaired-project-key');
    assert.equal(env.OPENROUTER_API_KEY,undefined);
    assert.match(repair.getRawOutput(),/COMMAND_CODE_API_KEY/);
    const explicit=new VirtualTerminal({isTTY:true});
    const selected=maybePromptForMissingProviderCredential(env,['node','babel','run','hello'],{input:explicit.stdin,output:explicit.stderr,projectRoot:root,connectionId:'router'});
    await explicit.waitForOutput('Paste API key (masked):',2000);explicit.sendLine('synthetic-explicit-router-key');await selected;
    assert.equal(env.OPENROUTER_API_KEY,'synthetic-explicit-router-key');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('headless and separated machine-output flags never open a credential prompt', async () => {
  const root=mkdtempSync(join(tmpdir(),'babel-machine-credential-'));
  const env:NodeJS.ProcessEnv={BABEL_STATE_DIR:root,BABEL_CONFIG_DIR:join(root,'config'),CI:'0'};
  updateUserSettings({connections:{router:{id:'router',provider:'openrouter',model:'vendor/model'}},defaults:{connection:'router'}},{env});
  try {
    for(const args of [['--output-format','stream-json'],['--output-format','json'],['--headless']]) {
      const term=new VirtualTerminal({isTTY:true});
      const pending=maybePromptForMissingProviderCredential(env,['node','babel','run','hello',...args],{input:term.stdin,output:term.stderr});
      const finished=await Promise.race([pending.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),250))]);
      if(!finished){term.sendCtrlC();await pending.catch(()=>{});}
      assert.equal(finished,true,`No credential prompt is allowed for ${args.join(' ')}`);
      assert.equal(term.getRawOutput().includes('Paste API key'),false);
    }
    env.BABEL_HEADLESS='1';
    const term=new VirtualTerminal({isTTY:true});
    await maybePromptForMissingProviderCredential(env,['node','babel','run','hello'],{input:term.stdin,output:term.stderr});
    assert.equal(term.getRawOutput().includes('Paste API key'),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('interactive credential entry masks API key and restores terminal mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-interactive-cred-'));
  const env: NodeJS.ProcessEnv = {
    BABEL_CONFIG_DIR: join(root, 'config'),
    BABEL_STATE_DIR: join(root, 'state'),
    CI: '0',
  };
  updateUserSettings({connections:{router:{id:'router',provider:'openrouter',model:'vendor/model'}},defaults:{connection:'router'}},{env});
  const term = new VirtualTerminal({ isTTY: true });
  const secret = 'sk-or-test-NEVER-PRINT-MASKED-INPUT';

  const promptPromise = maybePromptForMissingProviderCredential(env, ['node', 'babel', 'run', 'hello'], {
    input: term.stdin,
    output: term.stderr,
  });

  // Wait for masked key prompt, then paste synthetic key
  await term.waitForOutput('Paste API key (masked):', 2000);
  term.sendLine(secret);

  await promptPromise;

  // The credential must be set in env
  assert.equal(env['OPENROUTER_API_KEY'], secret);
  assert.equal(existsSync(join(root, 'config', '.env')), false, 'A one-shot run must not persist a key without consent.');

  // The raw output must NOT contain the secret API key anywhere
  const rawOutput = term.getRawOutput();
  assert.equal(rawOutput.includes(secret), false, 'Synthetic API key was echoed to terminal output!');

  // Terminal mode must be restored to not raw
  assert.equal(term.isRaw, false, 'Terminal was left in raw mode!');

  rmSync(root, { recursive: true, force: true });
});

test('readMaskedLine restores terminal mode on Ctrl+C cancellation', async () => {
  const term = new VirtualTerminal({ isTTY: true });
  const readPromise = readMaskedLine(term.stdin, term.stderr);

  await term.waitForOutput('Paste API key (masked):', 2000);
  assert.equal(term.isRaw, true);

  term.sendCtrlC();

  await assert.rejects(readPromise, /Credential setup cancelled/);
  assert.equal(term.isRaw, false, 'Terminal raw mode was not restored after cancellation!');
});

test('session-only masked credential entry does not write a plaintext profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-cred-'));
  const env: NodeJS.ProcessEnv = { BABEL_CONFIG_DIR: join(root, 'config'), CI: '0' };
  const term = new VirtualTerminal({ isTTY: true });
  try {
    const prompt = promptForProviderCredential('OPENROUTER_API_KEY', env, { input: term.stdin, output: term.stderr, persist: false });
    await term.waitForOutput('Paste API key (masked):', 2000);
    term.sendLine('synthetic-session-credential');
    assert.equal(await prompt, true);
    assert.equal(Boolean(env.OPENROUTER_API_KEY), true);
    assert.equal(existsSync(join(root, 'config', '.env')), false);
    assert.equal(term.getRawOutput().includes('synthetic-session-credential'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing profile entry is not silently replaced only in the current process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-existing-cred-'));
  const config = join(root, 'config'); mkdirSync(config);
  const file = join(config, '.env'); const original = 'OPENROUTER_API_KEY=synthetic-old\n';
  writeFileSync(file, original);
  const env: NodeJS.ProcessEnv = { BABEL_CONFIG_DIR: config, CI: '0' };
  const term = new VirtualTerminal({ isTTY: true });
  try {
    const prompt = promptForProviderCredential('OPENROUTER_API_KEY', env, { input: term.stdin, output: term.stderr, persist: true });
    await term.waitForOutput('Paste API key (masked):', 2000);
    term.sendLine('synthetic-new-credential');
    await assert.rejects(prompt, /already|existing/i);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(term.getRawOutput().includes('synthetic-new-credential'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit session repair replaces an in-memory key without writing a profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-repair-cred-'));
  const env: NodeJS.ProcessEnv = { BABEL_CONFIG_DIR: join(root, 'config'), CI: '0', OPENROUTER_API_KEY:'synthetic-old-key' };
  const term = new VirtualTerminal({ isTTY: true });
  try {
    const prompt = promptForProviderCredential('OPENROUTER_API_KEY', env, { input:term.stdin, output:term.stderr, persist:false, replaceExisting:true });
    await term.waitForOutput('Paste API key (masked):', 2000);
    term.sendLine('synthetic-new-key');
    assert.equal(await prompt,true);
    assert.equal(env.OPENROUTER_API_KEY,'synthetic-new-key');
    assert.equal(existsSync(join(root,'config','.env')),false);
    assert.equal(term.getRawOutput().includes('synthetic-new-key'),false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
}


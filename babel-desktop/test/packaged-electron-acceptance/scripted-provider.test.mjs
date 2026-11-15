// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {delimiter, dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {startScriptedProvider} from './scripted-provider.mjs';

function fixtureEnv(root) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (key && process.env[key]) env[name] = process.env[key];
  }
  return {...env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TEMP: root, TMP: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root};
}

test('scripted loopback provider limits its route, model, and bounded response sequence', async () => {
  const provider = await startScriptedProvider({port: 0, scenarioOrder: ['readOnly']});
  try {
    provider.selectScenario('readOnly');
    const url = `http://127.0.0.1:${provider.port}/v1/chat/completions`;
    const post = (body, headers = {}) => fetch(url, {method: 'POST',
      headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
    assert.equal((await post({model: 'wrong'})).status, 400);
    assert.equal((await post({model: 'local-fixture'}, {authorization: 'synthetic'})).status, 400);
    const responses = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await post({model: 'local-fixture', stream: false});
      assert.equal(response.status, 200);
      responses.push((await response.json()).choices[0].message.content);
    }
    assert.match(responses[0], /\[TOOL:read_file\]/);
    assert.match(responses[1], /\[TOOL:str_replace\]/);
    assert.match(responses[2], /subtracts/);
    assert.equal((await post({model: 'local-fixture'})).status, 400);
    await provider.waitForCounts(3, 3);
    assert.deepEqual(provider.snapshot(), {scenario: 'readOnly', calls: 3, rejected: 3});
  } finally { await provider.close(); }
});

test('repair script emits the scoped edit and verifier without fabricating their results', async () => {
  const provider = await startScriptedProvider({port: 0, scenarioOrder: ['repair']});
  try {
    provider.selectScenario('repair');
    const url = `http://127.0.0.1:${provider.port}/v1/chat/completions`;
    const outputs = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({model: 'local-fixture', stream: true})});
      assert.equal(response.status, 200);
      outputs.push(await response.text());
    }
    assert.match(outputs[2], /str_replace/);
    assert.match(outputs[3], /npm test/);
    assert.ok(outputs.every(text => text.includes('data: [DONE]')));
    await provider.waitForCounts(5, 0);
    assert.deepEqual(provider.snapshot(), {scenario: 'repair', calls: 5, rejected: 0});
  } finally { await provider.close(); }
});

test('a second scripted provider cannot take an owned loopback address', async () => {
  const provider = await startScriptedProvider({port: 0, scenarioOrder: ['repair']});
  try {
    await assert.rejects(startScriptedProvider({port: provider.port, scenarioOrder: ['repair']}), /bind|listen/i);
  } finally { await provider.close(); }
});

test('closing a scripted provider releases its loopback address', async () => {
  const provider = await startScriptedProvider({port: 0, scenarioOrder: ['readOnly']});
  let replacement, closed = false;
  try {
    await provider.close();
    closed = true;
    replacement = await startScriptedProvider({port: provider.port, scenarioOrder: ['readOnly']});
    const response = await fetch(`http://127.0.0.1:${replacement.port}/v1/chat/completions`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({model: 'local-fixture'})});
    assert.equal(response.status, 200);
    assert.match((await response.json()).choices[0].message.content, /\[TOOL:read_file\]/);
  } finally {
    if (replacement) await replacement.close();
    if (!closed) await provider.close();
  }
});

test('unexpected requests before the selected task cannot be hidden by resetting counters', async () => {
  const provider = await startScriptedProvider({port: 0, scenarioOrder: ['readOnly']});
  try {
    await fetch(`http://127.0.0.1:${provider.port}/v1/chat/completions`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({model: 'local-fixture'})});
    await provider.waitForCounts(1, 0);
    assert.throws(() => provider.selectScenario('readOnly'), /before the task/i);
  } finally { await provider.close(); }
});

test('retained provider survives its controller exiting and keeps the address exclusive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-retained-provider-'));
  let retained;
  let testError;
  try {
    const moduleUrl = new URL('./scripted-provider.mjs', import.meta.url).href;
    const program = `import {writeFileSync} from 'node:fs'; import {startScriptedProvider} from ${JSON.stringify(moduleUrl)};
      const provider = await startScriptedProvider({port: 0, scenarioOrder: ['readOnly']});
      writeFileSync(process.env.BABEL_RETAIN_RECEIPT, JSON.stringify({port: provider.port, ...provider.retain()})); process.exit(0);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {encoding: 'utf8', windowsHide: true,
      env: {...fixtureEnv(root), BABEL_RETAIN_RECEIPT: join(root, 'receipt')}});
    assert.equal(child.status, 0);
    retained = JSON.parse(await readFile(join(root, 'receipt'), 'utf8'));
    const url = `http://127.0.0.1:${retained.port}/v1/chat/completions`;
    const rejectedShutdown = await fetch(`http://127.0.0.1:${retained.port}/__fixture__/shutdown`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({nonce: 'invalid'}), signal: AbortSignal.timeout(5_000)});
    assert.equal(rejectedShutdown.status, 400);
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({model: 'local-fixture'}), signal: AbortSignal.timeout(5_000)});
    assert.equal(response.status, 200);
    assert.match((await response.json()).choices[0].message.content, /\[TOOL:read_file\]/);
    await assert.rejects(startScriptedProvider({port: retained.port, scenarioOrder: ['repair']}), /bind|listen/i);
    assert.equal(typeof retained.shutdownNonce, 'string');
  } catch (error) { testError = error; }
  finally {
    try {
      if (retained?.shutdownNonce) {
        const stopped = await fetch(`http://127.0.0.1:${retained.port}/__fixture__/shutdown`, {method: 'POST',
          headers: {'content-type': 'application/json'}, body: JSON.stringify({nonce: retained.shutdownNonce}),
          signal: AbortSignal.timeout(5_000)});
        assert.equal(stopped.status, 200);
      } else if (retained?.pid) {
        try { process.kill(retained.pid); } catch { }
      }
    } catch (error) { testError ??= error; }
    try { if (retained?.runtimeRoot) await rm(retained.runtimeRoot, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); }
    catch (error) { testError ??= error; }
    try { await rm(root, {recursive: true, force: true}); }
    catch (error) { testError ??= error; }
  }
  if (testError) throw testError;
});

test('retained provider survives termination of the controller process group', {
  skip: process.platform === 'win32' ? 'process-group signals require POSIX' : false,
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-provider-group-'));
  const receiptPath = join(root, 'receipt');
  const moduleUrl = new URL('./scripted-provider.mjs', import.meta.url).href;
  const program = `import {renameSync, writeFileSync} from 'node:fs'; import {startScriptedProvider} from ${JSON.stringify(moduleUrl)};
    const starting = startScriptedProvider({port: 0, scenarioOrder: ['readOnly']});
    process.once('SIGTERM', async () => { try { const provider = await starting; await provider.close(); } finally { process.exit(0); } });
    const provider = await starting;
    try {
      writeFileSync(process.env.BABEL_RETAIN_RECEIPT + '.tmp', JSON.stringify({port: provider.port, ...provider.retain()}));
      renameSync(process.env.BABEL_RETAIN_RECEIPT + '.tmp', process.env.BABEL_RETAIN_RECEIPT);
    } catch (error) { await provider.close(); throw error; }
    setInterval(() => {}, 1000);`;
  const controller = spawn(process.execPath, ['--input-type=module', '--eval', program], {
    detached: true, stdio: 'ignore', env: {...fixtureEnv(root), BABEL_RETAIN_RECEIPT: receiptPath},
  });
  const controllerClosed = new Promise((resolve, reject) => {
    controller.once('error', reject);
    controller.once('close', (code, signal) => resolve({code, signal}));
  });
  let retained, testError;
  try {
    const deadline = Date.now() + 15_000;
    while (!retained && Date.now() < deadline) {
      try { retained = JSON.parse(await readFile(receiptPath, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (controller.exitCode !== null || controller.signalCode !== null) throw new Error('controller exited before its receipt');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.ok(retained, 'controller did not publish a retention receipt');
    const endpoint = `http://127.0.0.1:${retained.port}`;
    const probe = await fetch(`${endpoint}/__fixture__/shutdown`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({nonce: 'invalid'}), signal: AbortSignal.timeout(5_000)});
    assert.equal(probe.status, 400);
    process.kill(-controller.pid, 'SIGKILL');
    assert.equal((await controllerClosed).signal, 'SIGKILL');
    const response = await fetch(`${endpoint}/v1/chat/completions`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({model: 'local-fixture'}), signal: AbortSignal.timeout(5_000)});
    assert.equal(response.status, 200);
    assert.match((await response.json()).choices[0].message.content, /\[TOOL:read_file\]/);
    await assert.rejects(startScriptedProvider({port: retained.port, scenarioOrder: ['repair']}), /bind|listen/i);
  } catch (error) { testError = error; }
  finally {
    if (controller.pid && controller.exitCode === null && controller.signalCode === null) {
      try {
        if (retained) process.kill(-controller.pid, 'SIGKILL');
        else controller.kill('SIGTERM');
        await controllerClosed;
      }
      catch (error) { if (error.code !== 'ESRCH') testError ??= error; }
    }
    if (retained?.shutdownNonce) {
      try {
        const stopped = await fetch(`http://127.0.0.1:${retained.port}/__fixture__/shutdown`, {method: 'POST',
          headers: {'content-type': 'application/json'}, body: JSON.stringify({nonce: retained.shutdownNonce}),
          signal: AbortSignal.timeout(5_000)});
        assert.equal(stopped.status, 200);
      } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') testError ??= error; }
    }
    try { if (retained?.runtimeRoot) await rm(retained.runtimeRoot, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); }
    catch (error) { testError ??= error; }
    try { await rm(root, {recursive: true, force: true}); }
    catch (error) { testError ??= error; }
  }
  if (testError) throw testError;
});

test('missing PowerShell is a bounded preflight failure', async () => {
  const previous = process.env.PATH;
  let timer;
  process.env.PATH = join(tmpdir(), 'babel-missing-powershell-path');
  try {
    await assert.rejects(Promise.race([
      startScriptedProvider({port: 0, scenarioOrder: ['repair']}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('preflight hung')), 3_000); }),
    ]), /bind|listen/);
  } finally {
    clearTimeout(timer);
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test('packaged entry point writes a classified receipt when the installed artifact is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-packaged-preflight-'));
  try {
    const fakeNpm = join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    await writeFile(fakeNpm, process.platform === 'win32' ? '@exit /b 19\r\n' : '#!/bin/sh\nexit 19\n');
    if (process.platform !== 'win32') await chmod(fakeNpm, 0o700);
    const runner = fileURLToPath(new URL('./run-packaged-gui.ps1', import.meta.url));
    const result = spawnSync('pwsh', ['-NoProfile', '-File', runner, '-InstallRoot', join(root, 'missing'),
      '-ArtifactDir', join(root, 'receipts'), '-SourceSha', 'a'.repeat(40)], {encoding: 'utf8', windowsHide: true,
      env: {...fixtureEnv(root), PATH: `${root}${delimiter}${process.env.PATH}`}});
    assert.notEqual(result.status, 0);
    const report = JSON.parse(await readFile(join(root, 'receipts', 'packaged-electron-acceptance.json'), 'utf8'));
    assert.equal(report.failure.stage, 'artifact-preflight');
    assert.equal(report.identity.requestedSourceSha, 'a'.repeat(40));
    assert.equal(report.passed, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('packaged entry point records dependency setup failure before launching Electron', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-packaged-dependency-'));
  try {
    const fakeNpm = join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    await writeFile(fakeNpm, process.platform === 'win32' ? '@exit /b 19\r\n' : '#!/bin/sh\nexit 19\n');
    if (process.platform !== 'win32') await chmod(fakeNpm, 0o700);
    await mkdir(join(root, 'install'));
    const runner = fileURLToPath(new URL('./run-packaged-gui.ps1', import.meta.url));
    const result = spawnSync('pwsh', ['-NoProfile', '-File', runner, '-InstallRoot', join(root, 'install'),
      '-ArtifactDir', join(root, 'receipts'), '-SourceSha', 'a'.repeat(40)], {encoding: 'utf8', windowsHide: true,
      env: {...fixtureEnv(root), PATH: `${root}${delimiter}${process.env.PATH}`}});
    assert.notEqual(result.status, 0);
    const report = JSON.parse(await readFile(join(root, 'receipts', 'packaged-electron-acceptance.json'), 'utf8'));
    assert.equal(report.failure.stage, 'dependency-preflight');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('packaged entry point records a missing npm executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-packaged-missing-npm-'));
  try {
    await mkdir(join(root, 'install'));
    const lookup = spawnSync('pwsh', ['-NoProfile', '-Command', '(Get-Command pwsh).Source'], {encoding: 'utf8',
      env: fixtureEnv(root)});
    assert.equal(lookup.status, 0);
    const pwsh = lookup.stdout.trim();
    const runner = fileURLToPath(new URL('./run-packaged-gui.ps1', import.meta.url));
    const result = spawnSync(pwsh, ['-NoProfile', '-File', runner, '-InstallRoot', join(root, 'install'),
      '-ArtifactDir', join(root, 'receipts'), '-SourceSha', 'a'.repeat(40)], {encoding: 'utf8', windowsHide: true,
      env: {...fixtureEnv(root), PATH: dirname(pwsh)}});
    assert.notEqual(result.status, 0);
    const report = JSON.parse(await readFile(join(root, 'receipts', 'packaged-electron-acceptance.json'), 'utf8'));
    assert.equal(report.failure.stage, 'dependency-preflight');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('packaged entry point keeps a current receipt if the acceptance process exits before reporting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-packaged-start-failure-'));
  try {
    const windows = process.platform === 'win32';
    const fakeNpm = join(root, windows ? 'npm.cmd' : 'npm');
    const fakeNode = join(root, windows ? 'node.cmd' : 'node');
    await writeFile(fakeNpm, windows ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    await writeFile(fakeNode, windows
      ? '@if exist "%BABEL_FAKE_NODE_COUNT_FILE%" exit /b 23\r\n@echo first>"%BABEL_FAKE_NODE_COUNT_FILE%"\r\n@exit /b 0\r\n'
      : '#!/bin/sh\nif [ -e "$BABEL_FAKE_NODE_COUNT_FILE" ]; then exit 23; fi\n: > "$BABEL_FAKE_NODE_COUNT_FILE"\nexit 0\n');
    if (!windows) { await chmod(fakeNpm, 0o700); await chmod(fakeNode, 0o700); }
    await mkdir(join(root, 'install'));
    const runner = fileURLToPath(new URL('./run-packaged-gui.ps1', import.meta.url));
    const result = spawnSync('pwsh', ['-NoProfile', '-File', runner, '-InstallRoot', join(root, 'install'),
      '-ArtifactDir', join(root, 'receipts'), '-SourceSha', 'a'.repeat(40)], {encoding: 'utf8', windowsHide: true,
      env: {...fixtureEnv(root), PATH: `${root}${delimiter}${process.env.PATH}`, BABEL_FAKE_NODE_COUNT_FILE: join(root, 'count')}});
    assert.equal(result.status, 23);
    const report = JSON.parse(await readFile(join(root, 'receipts', 'packaged-electron-acceptance.json'), 'utf8'));
    assert.equal(report.failure.stage, 'harness-start');
    assert.equal(report.passed, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

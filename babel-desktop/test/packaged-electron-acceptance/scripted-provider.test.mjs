// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {delimiter, dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {PassThrough} from 'node:stream';
import {startScriptedProvider} from './scripted-provider.mjs';
import {captureSanitizedStderr} from './sanitized-stderr.mjs';

function fixtureEnv(root) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (key && process.env[key]) env[name] = process.env[key];
  }
  return {...env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TEMP: root, TMP: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root};
}

test('stderr stream errors are classified without exposing the message', () => {
  const stream = new PassThrough();
  const receipt = captureSanitizedStderr(stream);
  stream.emit('error', new Error('FAKE_SECRET_MARKER'));
  assert.equal(receipt().streamError, true);
  assert.ok(!JSON.stringify(receipt()).includes('FAKE_SECRET_MARKER'));
  stream.destroy();
});

test('provider startup failure reports bounded sanitized stderr and exit ownership', {
  skip: process.platform === 'win32' ? 'uses a POSIX fixture executable' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-provider-diagnostic-'));
  const fake = join(root, 'pwsh');
  const previous = process.env.PATH;
  try {
    await writeFile(fake, '#!/bin/sh\ni=0; while [ "$i" -lt 400 ]; do printf "console handle is invalid HRESULT: 0xdeadbeef FAKE_SECRET_MARKER ">&2; i=$((i+1)); done\nexit 23\n');
    await chmod(fake, 0o700);
    process.env.PATH = root;
    let failure;
    try { await startScriptedProvider({port: 0, scenarioOrder: ['readOnly']}); }
    catch (error) { failure = error; }
    const diagnostic = failure?.diagnostic;
    assert.ok(diagnostic, 'startup failure must contain a diagnostic');
    assert.equal(diagnostic.phase, 'provider-start');
    assert.equal(diagnostic.exitCode, 23);
    assert.equal(diagnostic.controllerPid, process.pid);
    assert.ok(Number.isInteger(diagnostic.providerPid) && diagnostic.providerPid > 0);
    assert.equal(diagnostic.stderr.capturedBytes, 4096);
    assert.equal(diagnostic.stderr.truncated, true);
    assert.ok(diagnostic.stderr.categories.includes('console'));
    assert.ok(diagnostic.stderr.categories.includes('invalid-handle'));
    assert.ok(diagnostic.stderr.hresult === 'other', 'unknown HRESULT is classified without exposing its value');
    assert.ok(String(failure).includes(JSON.stringify(diagnostic)), 'reported error must contain the sanitized receipt');
    assert.ok(!JSON.stringify(diagnostic).includes('FAKE_SECRET_MARKER'));
    assert.ok(!JSON.stringify(diagnostic).includes('deadbeef'), 'stderr receipt must not expose an arbitrary HRESULT');
    assert.ok(!String(failure).includes('FAKE_SECRET_MARKER'));
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(root, {recursive: true, force: true});
  }
});

test('unresolved startup retains cleanup and lets its controller exit while the pipe holder runs', {
  skip: process.platform === 'win32' ? 'uses a POSIX fixture executable' : false,
  timeout: 12_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "babel-provider-controller-'-"));
  const holderPath = join(root, 'holder.mjs');
  const stopPath = join(root, 'stop');
  const donePath = join(root, 'done');
  const heartbeatPath = join(root, 'heartbeat');
  const receiptPath = join(root, 'result.json');
  const moduleUrl = new URL('./scripted-provider.mjs', import.meta.url).href;
  const cleanupUrl = new URL('./owned-cleanup.mjs', import.meta.url).href;
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  try {
    const holderScript = `import {existsSync, writeFileSync, renameSync} from 'node:fs';
      const stop = ${JSON.stringify(stopPath)}, done = ${JSON.stringify(donePath)}, beat = ${JSON.stringify(heartbeatPath)};
      const deadline = Date.now() + 12_000; let count = 0;
      while (Date.now() < deadline && !existsSync(stop)) {
        writeFileSync(beat + '.new', String(count++)); renameSync(beat + '.new', beat);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      writeFileSync(done, 'done');`;
    await writeFile(holderPath, holderScript);
    await writeFile(join(root, 'pwsh'), `#!/bin/sh\n${quote(process.execPath)} ${quote(holderPath)} &\nexit 23\n`);
    await chmod(join(root, 'pwsh'), 0o700);
    const controllerScript = `import {writeFileSync} from 'node:fs';
      import {startScriptedProvider} from ${JSON.stringify(moduleUrl)};
      import {cleanupOwnedFixture} from ${JSON.stringify(cleanupUrl)};
      let failure;
      try { await startScriptedProvider({port: 0, scenarioOrder: ['readOnly'], startupTimeoutMs: 300, cleanupTimeoutMs: 200}); }
      catch (error) { failure = error; }
      const operations = [];
      const cleanup = await cleanupOwnedFixture({startupFailure: failure, settleTurn: async () => {}, terminateTree: async () => true,
        releaseProvider: async () => operations.push('release'), retainProvider: () => operations.push('retain'),
        removeProfile: async () => operations.push('remove')});
      if (cleanup.state !== 'unresolved' || operations.join(',') !== 'retain') process.exitCode = 1;
      writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(failure?.diagnostic ?? {}));`;
    const controller = spawnSync(process.execPath, ['--input-type=module', '--eval', controllerScript], {
      env: {...fixtureEnv(root), PATH: root, TMPDIR: root}, stdio: 'ignore', timeout: 3_000,
    });
    assert.equal(controller.status, 0, 'controller must exit after reporting unresolved cleanup');
    let receipt;
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); } catch { throw new Error('invalid synthetic controller receipt'); }
    assert.equal(receipt.phase, 'provider-drain-timeout');
    assert.equal(receipt.exitCode, 23);
    assert.equal(receipt.cleanup, 'unresolved');
    let first;
    let deadline = Date.now() + 2_000;
    while (Date.now() < deadline && first === undefined) {
      try { first = await readFile(heartbeatPath, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (first === undefined) await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.notEqual(first, undefined, 'pipe holder must start');
    deadline = Date.now() + 2_000;
    let changed = false;
    while (Date.now() < deadline && !changed) {
      await new Promise(resolve => setTimeout(resolve, 40));
      changed = (await readFile(heartbeatPath, 'utf8')) !== first;
    }
    assert.ok(changed, 'pipe holder must still make progress after controller exit');
  } finally {
    await writeFile(stopPath, 'stop');
    const deadline = Date.now() + 3_000;
    let done = false;
    while (Date.now() < deadline && !done) {
      try { await readFile(donePath); done = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!done) await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (!done) throw new Error('synthetic pipe holder cleanup is unresolved');
    await rm(root, {recursive: true, force: true});
  }
});

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

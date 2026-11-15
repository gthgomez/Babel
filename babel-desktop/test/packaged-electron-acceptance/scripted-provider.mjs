// License: Apache-2.0
// Test-owned Ollama-compatible endpoint. It returns proposals, never tool results.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureSanitizedStderr, sanitizeSignal, sanitizeSpawnCode} from './sanitized-stderr.mjs';

const read = path => `[TOOL:read_file]\npath: ${path}`;
const edit = '[TOOL:str_replace]\nfile_path: parser.mjs\nold_str: a - b\nnew_str: a + b';
const scripts = Object.freeze({
  readOnly: [read('parser.mjs'), edit, 'The parser subtracts rather than adding.'],
  repair: [read('parser.mjs'), read('verify.mjs'), edit,
    '[TOOL:run_command]\ncommand: npm test', 'Fixed the parser; npm test passed.'],
});
const serverScript = fileURLToPath(new URL('./scripted-provider.ps1', import.meta.url));
const emptyStderr = () => ({capturedBytes: 0, truncated: false, categories: [], hresult: null, streamError: false});

function narrowProviderEnv(runtimeRoot) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (key && process.env[key]) env[name] = process.env[key];
  }
  return {...env, HOME: runtimeRoot, USERPROFILE: runtimeRoot, TEMP: runtimeRoot, TMP: runtimeRoot,
    XDG_CACHE_HOME: runtimeRoot, XDG_DATA_HOME: runtimeRoot};
}

// Detached pwsh with piped stdin exits 0 before this script runs. A detached Node
// supervisor owns an attached pwsh process, so the same script, environment, and
// stdin line still outlive the controller.
async function superviseWindowsProvider() {
  const root = process.env.BABEL_PROVIDER_ROOT;
  if (!root) throw new Error('provider root is required');
  const eventsPath = join(root, 'events.jsonl');
  const stopPath = join(root, 'stop');
  const append = value => appendFileSync(eventsPath, JSON.stringify(value) + '\n', {mode: 0o600});
  let child = null;
  let spawnCode = null;
  let finished = false;
  const finish = (code, signal, stderr) => {
    if (finished) return;
    finished = true;
    append({event: 'supervisor-exit', exitCode: Number.isInteger(code) ? code : null, signal: sanitizeSignal(signal),
      spawnCode, providerPid: child?.pid ?? null, stderr: stderr ?? emptyStderr()});
    process.exit(0);
  };
  try {
    const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
    const env = narrowProviderEnv(root);
    child = spawn('pwsh', ['-NoProfile', '-File', serverScript], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderrReceipt = captureSanitizedStderr(child.stderr);
    child.on('error', error => { spawnCode = sanitizeSpawnCode(error.code ?? 'other'); });
    child.stdin.on('error', () => {});
    if (child.pid) append({event: 'spawned', providerPid: child.pid});
    child.stdin.write(`${JSON.stringify({port: config.port, steps: config.steps, shutdownNonce: config.shutdownNonce})}\n`);
    let output = '';
    const stopTimer = setInterval(() => {
      if (!existsSync(stopPath)) return;
      clearInterval(stopTimer);
      try { child.kill(); } catch { /* The listener may already have exited. */ }
    }, 25);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.length > 65_536) { try { child.kill(); } catch { /* already exited */ } return; }
      let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline).replace(/\r$/, '');
        output = output.slice(newline + 1);
        if (line) appendFileSync(eventsPath, line + '\n', {mode: 0o600});
      }
    });
    child.once('close', (code, signal) => {
      clearInterval(stopTimer);
      finish(code, signal, stderrReceipt());
    });
  } catch {
    finish(1, null, emptyStderr());
  }
}

if (process.argv[2] === '--supervise') await superviseWindowsProvider();

async function startAttachedWindowsProvider({runtimeRoot, shutdownNonce, port, scenarioOrder, startupTimeoutMs, cleanupTimeoutMs}) {
  const eventsPath = join(runtimeRoot, 'events.jsonl');
  const stopPath = join(runtimeRoot, 'stop');
  const steps = scenarioOrder.flatMap(name => scripts[name]);
  await writeFile(join(runtimeRoot, 'config.json'), `${JSON.stringify({port, steps, shutdownNonce})}\n`, {mode: 0o600});
  const supervisor = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise'], {
    env: {...process.env, BABEL_PROVIDER_ROOT: runtimeRoot}, windowsHide: true, detached: true, stdio: 'ignore',
  });
  let accepted = 0, rejected = 0, scenario = null, scenarioIndex = -1, acceptedAtStart = 0, rejectedAtStart = 0;
  let serverError = null, readySeen = false, spawnCode = null, exitSeen = false, providerPid = null;
  let observedExitCode = null, observedSignal = null, stderrSnapshot = emptyStderr();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const supervisorClosed = new Promise(resolve => supervisor.once('close', () => resolve()));
  const diagnostic = (phase, code = observedExitCode, signal = observedSignal) => ({
    phase, controllerPid: process.pid, providerPid, exitCode: Number.isInteger(code) ? code : null,
    signal: sanitizeSignal(signal), spawnCode, stderr: stderrSnapshot,
  });
  const diagnosticError = details => {
    const error = new Error('scripted provider listener failed: ' + JSON.stringify(details));
    error.diagnostic = details;
    return error;
  };
  const timer = setTimeout(() => readyReject(diagnosticError(diagnostic(
    exitSeen ? 'provider-drain-timeout' : 'provider-timeout'))), startupTimeoutMs);
  const requestStop = () => { try { writeFileSync(stopPath, 'stop'); } catch { /* cleanup still waits */ } };
  const consume = line => {
    let event;
    try { event = JSON.parse(line); }
    catch { serverError = new Error('scripted provider sent an invalid receipt'); requestStop(); return; }
    if (event.event === 'spawned' && Number.isInteger(event.providerPid)) { providerPid = event.providerPid; return; }
    if (event.event === 'ready' && Number.isInteger(event.port)) { readySeen = true; readyResolve(event.port); return; }
    if (event.event === 'request') { if (event.accepted === true) accepted++; else rejected++; return; }
    if (event.event === 'supervisor-exit') {
      exitSeen = true;
      observedExitCode = event.exitCode;
      observedSignal = event.signal;
      spawnCode = event.spawnCode ?? spawnCode;
      if (event.stderr) stderrSnapshot = event.stderr;
      if (Number.isInteger(event.providerPid)) providerPid = event.providerPid;
      serverError = diagnosticError(diagnostic(readySeen ? 'provider-runtime' : 'provider-start', event.exitCode, event.signal));
      if (!readySeen) readyReject(serverError);
    }
  };
  let seenLength = 0;
  let pending = '';
  const poll = setInterval(() => {
    let text;
    try { text = readFileSync(eventsPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') { serverError = error; requestStop(); } return; }
    if (text.length > 65_536) { serverError = new Error('scripted provider output limit exceeded'); requestStop(); return; }
    if (text.length < seenLength) return;
    pending += text.slice(seenLength);
    seenLength = text.length;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line) consume(line);
    }
  }, 20);
  poll.unref();
  const stopChild = async () => {
    requestStop();
    let stopTimer;
    try {
      await Promise.race([supervisorClosed, new Promise((_, reject) => {
        stopTimer = setTimeout(() => reject(new Error('scripted provider cleanup timed out')), cleanupTimeoutMs);
      })]);
    } finally { clearTimeout(stopTimer); }
  };
  let boundPort;
  try { boundPort = await ready; }
  catch (error) {
    try { await stopChild(); }
    catch {
      clearInterval(poll);
      supervisor.unref();
      throw diagnosticError({...error.diagnostic, cleanup: 'unresolved'});
    }
    clearInterval(poll);
    await rm(runtimeRoot, {recursive: true, force: true});
    throw error;
  }
  finally { clearTimeout(timer); }
  const snapshot = () => ({scenario, calls: accepted - acceptedAtStart, rejected: rejected - rejectedAtStart});
  return {
    port: boundPort,
    selectScenario(next) {
      if (scenarioIndex === -1 && (accepted !== 0 || rejected !== 0)) throw new Error('unexpected provider request before the task');
      if (scenarioOrder[scenarioIndex + 1] !== next || (scenario && snapshot().calls !== scripts[scenario].length)) {
        throw new Error('scripted provider scenario is invalid or incomplete');
      }
      scenarioIndex++; scenario = next; acceptedAtStart = accepted; rejectedAtStart = rejected;
    },
    snapshot,
    async waitForCounts(expectedCalls, expectedRejected, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (serverError) throw serverError;
        const state = snapshot();
        if (state.calls === expectedCalls && state.rejected === expectedRejected) return state;
        if (state.calls > expectedCalls || state.rejected > expectedRejected || Date.now() >= deadline) {
          throw new Error('scripted provider request counts do not match');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    close: async () => {
      clearInterval(poll);
      await stopChild();
      await rm(runtimeRoot, {recursive: true, force: true});
    },
    retain: () => {
      supervisor.unref();
      return {pid: providerPid, supervisorPid: supervisor.pid ?? null, runtimeRoot, shutdownNonce};
    },
  };
}

/** Bind the fixed loopback endpoint with Windows socket exclusivity before launching Desktop. */
export async function startScriptedProvider({port = 11434, scenarioOrder = ['readOnly', 'repair'],
  startupTimeoutMs = 15_000, cleanupTimeoutMs = 5_000} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !scenarioOrder.length ||
      scenarioOrder.some(name => !Object.hasOwn(scripts, name)) ||
      !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 15_000 ||
      !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 5_000) {
    throw new Error('invalid scripted provider configuration');
  }
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'babel-scripted-provider-'));
  const shutdownNonce = randomBytes(32).toString('hex');
  if (process.platform === 'win32') {
    return startAttachedWindowsProvider({runtimeRoot, shutdownNonce, port, scenarioOrder, startupTimeoutMs, cleanupTimeoutMs});
  }
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (key && process.env[key]) env[name] = process.env[key];
  }
  Object.assign(env, {HOME: runtimeRoot, USERPROFILE: runtimeRoot, TEMP: runtimeRoot, TMP: runtimeRoot,
    XDG_CACHE_HOME: runtimeRoot, XDG_DATA_HOME: runtimeRoot});
  // A retained listener must outlive its controller and its process group.
  const child = spawn('pwsh', ['-NoProfile', '-File', serverScript], {
    env, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  let output = '', accepted = 0, rejected = 0, scenario = null, scenarioIndex = -1, acceptedAtStart = 0, rejectedAtStart = 0;
  let serverError = null, readySeen = false, spawnCode = null, exitSeen = false;
  let observedExitCode = null, observedSignal = null;
  const stderrReceipt = captureSanitizedStderr(child.stderr);
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const diagnostic = (phase, code = observedExitCode, signal = observedSignal) => {
    return {phase, controllerPid: process.pid, providerPid: child.pid ?? null,
      exitCode: Number.isInteger(code) ? code : null,
      signal: sanitizeSignal(signal),
      spawnCode, stderr: stderrReceipt()};
  };
  const diagnosticError = details => {
    const error = new Error('scripted provider listener failed: ' + JSON.stringify(details));
    error.diagnostic = details;
    return error;
  };
  const childClosed = new Promise(resolve => child.once('close', (code, signal) => {
    serverError = diagnosticError(diagnostic(readySeen ? 'provider-runtime' : 'provider-start', code, signal));
    if (!readySeen) readyReject(serverError);
    resolve();
  }));
  const timer = setTimeout(() => readyReject(diagnosticError(diagnostic(
    exitSeen ? 'provider-drain-timeout' : 'provider-timeout'))), startupTimeoutMs);
  child.on('error', error => {
    spawnCode = sanitizeSpawnCode(error.code ?? 'other');
  });
  child.stderr.on('error', () => {
    serverError = diagnosticError(diagnostic('provider-stderr'));
    if (!readySeen) readyReject(serverError);
  });
  child.on('exit', (code, signal) => {
    exitSeen = true; observedExitCode = code; observedSignal = signal;
    if (readySeen) serverError = diagnosticError(diagnostic('provider-runtime', code, signal));
  });
  child.stdout.on('data', chunk => {
    output += String(chunk);
    if (output.length > 65_536) { serverError = new Error('scripted provider output limit exceeded'); child.kill(); return; }
    let newline;
    while ((newline = output.indexOf('\n')) !== -1) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      let event;
      try { event = JSON.parse(line); } catch { serverError = new Error('scripted provider sent an invalid receipt'); child.kill(); return; }
      if (event.event === 'ready' && Number.isInteger(event.port)) { readySeen = true; readyResolve(event.port); }
      else if (event.event === 'request') { if (event.accepted === true) accepted++; else rejected++; }
      else if (event.event === 'error') { /* Wait for close to capture the bounded diagnostic. */ }
    }
  });
  child.stdin.write(`${JSON.stringify({port, steps: scenarioOrder.flatMap(name => scripts[name]), shutdownNonce})}\n`);
  const unrefChild = () => {
    child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.(); child.unref();
  };
  const stopChild = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    let stopTimer;
    try {
      await Promise.race([childClosed, new Promise((_, reject) => {
        stopTimer = setTimeout(() => reject(new Error('scripted provider cleanup timed out')), cleanupTimeoutMs);
      })]);
    } finally { clearTimeout(stopTimer); }
  };
  let boundPort;
  try { boundPort = await ready; }
  catch (error) {
    try { await stopChild(); }
    catch {
      unrefChild();
      throw diagnosticError({...error.diagnostic, cleanup: 'unresolved'});
    }
    await rm(runtimeRoot, {recursive: true, force: true});
    throw error;
  }
  finally { clearTimeout(timer); }
  const snapshot = () => ({scenario, calls: accepted - acceptedAtStart, rejected: rejected - rejectedAtStart});
  return {
    port: boundPort,
    selectScenario(next) {
      if (scenarioIndex === -1 && (accepted !== 0 || rejected !== 0)) throw new Error('unexpected provider request before the task');
      if (scenarioOrder[scenarioIndex + 1] !== next || (scenario && snapshot().calls !== scripts[scenario].length)) {
        throw new Error('scripted provider scenario is invalid or incomplete');
      }
      scenarioIndex++; scenario = next; acceptedAtStart = accepted; rejectedAtStart = rejected;
    },
    snapshot,
    async waitForCounts(expectedCalls, expectedRejected, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (serverError) throw serverError;
        const state = snapshot();
        if (state.calls === expectedCalls && state.rejected === expectedRejected) return state;
        if (state.calls > expectedCalls || state.rejected > expectedRejected || Date.now() >= deadline) {
          throw new Error('scripted provider request counts do not match');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    close: async () => {
      await stopChild();
      await rm(runtimeRoot, {recursive: true, force: true});
    },
    retain: () => {
      unrefChild();
      return {pid: child.pid, runtimeRoot, shutdownNonce};
    },
  };
}

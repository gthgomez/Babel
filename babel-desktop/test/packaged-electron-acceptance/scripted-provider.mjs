// License: Apache-2.0
// Test-owned Ollama-compatible endpoint. It returns proposals, never tool results.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
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

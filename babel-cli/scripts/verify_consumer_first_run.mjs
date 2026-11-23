// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consumerEnvironment } from './consumer_environment.mjs'

const keys = ['synthetic-setup-account-alpha', 'synthetic-setup-account-beta']
const flash = 'deepseek/deepseek-v4.1-flash-1017'
const unpricedFlash = 'deepseek/deepseek-v4.1-flash'
const unframedTail = 'synthetic-unframed-key-tail'

async function drive(child, steps, { exitCode = 0, timeout = 45_000 } = {}) {
  let transcript = ''
  let cursor = 0
  let step = 0
  const timer = setTimeout(() => child.kill(), timeout)
  const observe = chunk => {
    transcript += chunk
    while (step < steps.length) {
      const [expected, input] = steps[step]
      const found = transcript.indexOf(expected, cursor)
      if (found < 0) break
      cursor = found + expected.length
      step++
      if (input !== undefined) child.stdin.write(input)
    }
  }
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject).once('close', resolve)
      child.stdin.on('error', () => {})
      child.stdout?.setEncoding('utf8').on('data', observe)
      child.stderr.setEncoding('utf8').on('data', observe)
    })
    assert.equal(step, steps.length, `First run stopped waiting for: ${steps[step]?.[0] ?? 'exit'}`)
    assert.equal(code, exitCode, 'Installed command did not exit with the expected status.')
    return transcript
  } finally { clearTimeout(timer); child.kill() }
}

function hasKey(value) {
  return keys.some(key => value.includes(key))
}

function checkArtifacts(path, allowedAccountFile) {
  if (!existsSync(path)) return
  for (const file of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, file.name)
    if (file.isDirectory()) checkArtifacts(child, allowedAccountFile)
    else if (file.isFile() && child !== allowedAccountFile) {
      assert.equal(hasKey(readFileSync(child)), false, 'Setup leaked a key into a user or project artifact.')
    }
  }
}

/** Verify the installed entrypoint using a scripted TTY stream on each consumer OS. */
export async function verifyInstalledFirstRun(bin, root, { realPty = false } = {}) {
  const project = join(root, 'workspace')
  const env = consumerEnvironment(process.env, root)
  mkdirSync(project, { recursive: true })
  mkdirSync(env.HOME, { recursive: true })
  const preload = join(root, 'first-run-fixture.mjs')
  const guard = new URL('./block_consumer_network.mjs', import.meta.url)
  writeFileSync(preload, `
    import ${JSON.stringify(guard.href)};
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const keys = ${JSON.stringify(keys)};
    const exposed = env => Object.values(env).some(value => keys.some(key => String(value).includes(key)));
    const requests = [];
    let childEnvExposed = false;
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
      const original = childProcess[name];
      childProcess[name] = (...args) => {
        const options = args.slice(1).find(value => value && typeof value === 'object' && !Array.isArray(value));
        if (exposed(options?.env ?? process.env)) childEnvExposed = true;
        return original.apply(childProcess, args);
      };
    }
    syncBuiltinESMExports();
    if (${JSON.stringify(!realPty)}) {
      Object.assign(process.stdin, { isTTY: true, isRaw: false, setRawMode(raw) { this.isRaw = raw; return this; } });
      Object.assign(process.stdout, { isTTY: process.env.FIRST_RUN_REDIRECT_STDOUT !== '1', columns: 132, rows: 36 });
      process.stderr.isTTY = true;
    }
    globalThis.fetch = async (url, init) => {
      const keyIndex = keys.findIndex(key => new Headers(init?.headers).get('authorization') === 'Bearer ' + key);
      if (String(url) !== 'https://openrouter.ai/api/v1/models/user' || init?.method !== 'GET' ||
          init?.body !== undefined || init.redirect !== 'error' || keyIndex < 0) {
        requests.push('unexpected');
        throw new Error('Unexpected network request in setup fixture.');
      }
      requests.push(keyIndex);
      return Response.json({ data: [{ id: ${JSON.stringify(flash)}, supported_parameters: ['tools'] }] });
    };
    process.on('exit', () => writeFileSync(join(${JSON.stringify(root)}, 'setup-receipt-' + process.pid + '.json'), JSON.stringify({
      requests, childEnvExposed,
      parentEnvExposed: exposed(process.env),
    })));
  `)
  Object.assign(env, {
    TERM: 'xterm-256color', BABEL_DAEMON_WARM: '0', BABEL_SKIP_KG_INDEX: '1',
  })
  const args = ['--import', pathToFileURL(preload).href, bin]
  const scope = { cwd: project, env, windowsHide: true }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const launch = (command = [], overrides = {}, stdoutFile) => {
    const childScope = { ...scope, env: { ...env, ...overrides, ...(stdoutFile ? { FIRST_RUN_REDIRECT_STDOUT: '1' } : {}) } }
    const commandArgs = [...args, ...command]
    const redirect = stdoutFile ? ` > ${quote(stdoutFile)}` : ''
    if (realPty) return spawn('script', ['-qefc', 'stty rows 36 cols 132 && exec ' +
      [process.execPath, ...commandArgs].map(quote).join(' ') + redirect, '/dev/null'], childScope)
    if (!stdoutFile) return spawn(process.execPath, commandArgs, childScope)
    const fd = openSync(stdoutFile, 'wx', 0o600)
    try { return spawn(process.execPath, commandArgs, { ...childScope, stdio: ['pipe', fd, 'pipe'] }) }
    finally { closeSync(fd) }
  }
  const standalone = await drive(launch(['setup']), [
    ['Provider number (Esc back): ', '\x1b\r'],
    ['Setup left your active connection unchanged.', undefined],
  ], { timeout: 15_000 })
  assert.equal(hasKey(standalone), false)

  const stale = await drive(launch(['interactive'], { BABEL_CONNECTION: 'unavailable-fixture-account' }), [
    ['The selected connection is unavailable.', undefined],
    ['Provider number (Esc back): ', '\x1b\r'],
    ['Input › ', '/exit\r'],
  ])
  assert.equal(hasKey(stale), false)

  const resume = await drive(launch(['interactive', '--resume', 'fixture-no-such-session']), [
    ['Failed to resume fixture-no-such-session:', undefined],
    ['Input › ', '/exit\r'],
  ])
  assert.equal(resume.includes('Provider number (Esc back)'), false, 'Explicit resume must not wait for setup.')

  const redirectConfig = join(root, 'redirect-config')
  const redirectState = join(root, 'redirect-state')
  const stdoutPath = join(root, 'redirected-stdout.txt')
  const redirected = await drive(launch(['setup'], {
    BABEL_CONFIG_DIR: redirectConfig, BABEL_STATE_DIR: redirectState,
  }, stdoutPath), [
    ['Provider number (Esc back): ', '1\r'],
    ['Connection name [openrouter] (Esc back): ', '\r'],
    ['Key number (Esc back): ', '\r'],
    ['Paste API key (masked, Esc back): ', `${keys[0]}\r`],
    ['Connection number (Esc back): ', `${unframedTail}\r`],
    ['Choose one of the displayed numbers.', undefined],
    ['Connection number (Esc back): ', '\x1b\r'],
    ['Provider number (Esc back): ', '\x03'],
  ], { timeout: 15_000 })
  assert.equal(redirected.includes('\x1b[?2004h'), true, 'Bracketed paste should be enabled on the prompt TTY.')
  const redirectedOutput = redirected + (existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '')
  assert.equal(hasKey(redirectedOutput) || redirectedOutput.includes(unframedTail), false, 'Redirected setup exposed a key fragment.')

  const transcript = await drive(launch(), [
    ['Provider number (Esc back): ', '\r'],
    ['Provider number (Esc back): ', '\x1b'],
    ['Input › ', '/setup\r'],
    ['Provider number (Esc back): ', '1\r'],
    ['Connection name [openrouter] (Esc back): ', '\r'],
    ['Key number (Esc back): ', '\r'],
    ['Paste API key (masked, Esc back): ', `${keys[0]}\r`],
    ['Connection number (Esc back): ', '2\r'],
    ['Model number, search text', 'flash\r'],
    ['Model number, search text', '1\r'],
    ['Spending number (Esc back): ', '1\r'],
    ['Per-task cap in USD (Esc back): ', '3\r'],
    ['Selected openrouter ·', undefined],
    ['Input › ', '/setup\r'],
    ['Provider number (Esc back): ', '1\r'],
    ['Account number (Esc back): ', '2\r'],
    ['Connection name [openrouter-2] (Esc back): ', '\r'],
    ['Key number (Esc back): ', '\r'],
    ['Paste API key (masked, Esc back): ', `${keys[1]}\r`],
    ['Connection number (Esc back): ', '\r'],
    ['Model number, search text', '\x1b'],
    ['Connection number (Esc back): ', '\x1b'],
    ['Provider number (Esc back): ', '\x03'],
    ['Setup cancelled.', undefined],
    ['Input › ', '/setup\r'],
    ['Provider number (Esc back): ', '1\r'],
    ['Account number (Esc back): ', '2\r'],
    ['Key number (Esc back): ', '\r'],
    ['Connection number (Esc back): ', '2\r'],
    ['Model number, search text', '1\r'],
    ['Selected openrouter-2 ·', undefined],
    ['Input › ', '/provider use openrouter\r'],
    ['"selected": "openrouter"', '/exit\r'],
    ['Babel session ended.', undefined],
  ])
  const beforeSetup = transcript.slice(0, transcript.indexOf('Selected openrouter ·'))
  assert.equal(beforeSetup.includes('Connect a provider to chat'), true)
  assert.equal(/Type a task to get started|type a task, or/i.test(beforeSetup), false)
  assert.equal(hasKey(transcript), false, 'Setup transcript exposed a fixture key.')
  const refused = await drive(launch(['work', '--headless', '--execution-scope', 'conversation', 'Hello from the fixture.'], {
    BABEL_MODEL: unpricedFlash, BABEL_DRY_RUN: '0',
  }), [
    ['Cannot preauthorize the next request under a finite cap', undefined],
  ], { exitCode: 1 })
  assert.equal(refused.includes('Provider env variable to set'), false, 'Work must not prompt for an unrelated environment credential.')
  assert.equal(hasKey(refused), false, 'Work output exposed a profile key.')
  const receipts = readdirSync(root).filter(name => /^setup-receipt-\d+\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(join(root, name), 'utf8')))
  assert.deepEqual(receipts.flatMap(receipt => receipt.requests), [0, 1], 'Only the two explicit metadata checks may dispatch.')
  assert.equal(receipts.some(receipt => receipt.childEnvExposed || receipt.parentEnvExposed), false, 'Setup keys must not enter any environment.')
  const status = spawnSync(process.execPath, [bin, 'provider', 'status', '--json'], {
    ...scope, env: { ...env, NODE_OPTIONS: `--import=${guard.href}` }, encoding: 'utf8', timeout: 15_000,
  })
  assert.equal(status.status, 0, 'Installed provider status should survive a restart.')
  assert.equal(hasKey(status.stdout + status.stderr), false, 'Status exposed a fixture key.')
  const report = JSON.parse(status.stdout)
  assert.equal(report.state, 'configured_unverified')
  assert.equal(report.connection, 'openrouter-2')
  assert.equal(report.model, flash)
  assert.equal(report.credential.present, true)
  assert.equal(report.budget.requested_usd, 3)
  for (const config of [env.BABEL_CONFIG_DIR, redirectConfig]) {
    const accountFile = join(config, '.env.accounts')
    assert.equal(existsSync(accountFile), true)
    checkArtifacts(config, accountFile)
  }
  for (const path of [project, env.BABEL_STATE_DIR, env.BABEL_CACHE_DIR, redirectState]) checkArtifacts(path)
  return { transport: realPty ? 'real PTY' : 'scripted TTY on pipes', metadataRequests: 2, inferenceRequests: 0 }
}

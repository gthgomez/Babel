// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consumerEnvironment } from './consumer_environment.mjs'

const keys = ['synthetic-setup-account-alpha', 'synthetic-setup-account-beta']
const flash = 'deepseek/deepseek-v4.1-flash'

async function drive(child, steps) {
  let transcript = ''
  let cursor = 0
  let step = 0
  const timer = setTimeout(() => child.kill(), 45_000)
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
      child.stdout.setEncoding('utf8').on('data', observe)
      child.stderr.setEncoding('utf8').on('data', observe)
    })
    assert.equal(step, steps.length, `First run stopped waiting for: ${steps[step]?.[0] ?? 'exit'}`)
    assert.equal(code, 0, 'First-run session should exit only when requested.')
    return transcript
  } finally { clearTimeout(timer); child.kill() }
}

function hasKey(value) {
  return keys.some(key => value.includes(key))
}

function checkArtifacts(path) {
  if (!existsSync(path)) return
  for (const file of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, file.name)
    if (file.isDirectory()) checkArtifacts(child)
    else if (file.isFile() && file.name !== '.env.accounts') {
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
    const requests = [];
    let childEnvExposed = false;
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
      const original = childProcess[name];
      childProcess[name] = (...args) => {
        const options = args.slice(1).find(value => value && typeof value === 'object' && !Array.isArray(value));
        if (Object.values(options?.env ?? process.env).some(value => keys.includes(value))) childEnvExposed = true;
        return original.apply(childProcess, args);
      };
    }
    syncBuiltinESMExports();
    if (${JSON.stringify(!realPty)}) {
      Object.assign(process.stdin, { isTTY: true, isRaw: false, setRawMode(raw) { this.isRaw = raw; return this; } });
      Object.assign(process.stdout, { isTTY: true, columns: 132, rows: 36 });
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
      parentEnvExposed: Object.values(process.env).some(value => keys.includes(value)),
    })));
  `)
  Object.assign(env, {
    TERM: 'xterm-256color', BABEL_DAEMON_WARM: '0', BABEL_SKIP_KG_INDEX: '1',
  })
  const args = ['--import', pathToFileURL(preload).href, bin]
  const scope = { cwd: project, env, windowsHide: true }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const child = realPty
    ? spawn('script', ['-qefc', 'stty rows 36 cols 132 && exec ' + [process.execPath, ...args].map(quote).join(' '), '/dev/null'], scope)
    : spawn(process.execPath, args, scope)
  const transcript = await drive(child, [
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
  assert.equal(existsSync(join(env.BABEL_CONFIG_DIR, '.env.accounts')), true)
  assert.equal(existsSync(join(project, '.env.accounts')), false)
  for (const path of [project, env.BABEL_CONFIG_DIR, env.BABEL_STATE_DIR, env.BABEL_CACHE_DIR]) checkArtifacts(path)
  return { transport: realPty ? 'real PTY' : 'scripted TTY on pipes', metadataRequests: 2, inferenceRequests: 0 }
}

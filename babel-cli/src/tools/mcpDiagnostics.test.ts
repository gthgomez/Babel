import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  summarizeMcpServerForDiagnostics,
  summarizeMcpServersForDiagnostics,
} from '../mcp/diagnostics.js'

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = resolve(CLI_ROOT, '..')

function runCli(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--no-warnings=ExperimentalWarning', 'src/index.ts', ...args],
    {
      cwd: CLI_ROOT,
      env: { ...process.env, BABEL_ROOT: REPO_ROOT, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    },
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

test('MCP diagnostic summaries omit all argument values', () => {
  const summary = summarizeMcpServerForDiagnostics({
    command: 'node',
    args: ['--example-setting', 'SYNTHETIC_W09_SENTINEL_ALPHA', 'server.js'],
  })
  assert.deepEqual(summary, {
    command: 'node',
    args: ['[REDACTED]', '[REDACTED]', '[REDACTED]'],
    arg_count: 3,
    args_redacted: true,
  })
  assert.doesNotMatch(JSON.stringify(summary), /SYNTHETIC_W09_ARG/)
})

test('MCP diagnostic summaries preserve plugin provenance without local paths', () => {
  const summary = summarizeMcpServersForDiagnostics({
    plugin_server: {
      command: 'node',
      args: ['--token', 'SYNTHETIC_W09_TOKEN'],
      origin: {
        kind: 'plugin',
        plugin_id: 'sample-plugin',
        manifest_path: 'tests/fixtures/plugin-proofs/example/plugin.json',
        manifest_sha256: 'a'.repeat(64),
      },
    },
  })
  assert.deepEqual(summary['plugin_server']?.origin, {
    kind: 'plugin',
    plugin_id: 'sample-plugin',
    manifest_sha256: 'a'.repeat(64),
  })
  assert.doesNotMatch(
    JSON.stringify(summary),
    /SYNTHETIC_W09_TOKEN|plugin-proofs/,
  )
})

test('removing the last server through the CLI survives a fresh process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-mcp-remove-restart-'))
  writeFileSync(
    join(dir, 'mcp_servers.json'),
    JSON.stringify({
      servers: { local: { command: 'node', args: ['server.js'] } },
    }),
    'utf8',
  )
  try {
    const removed = runCli(['mcp', 'remove', 'local', '--json'], { BABEL_CONFIG_DIR: dir })
    assert.equal(removed.status, 0, removed.stderr)

    const listed = runCli(['mcp', 'list', '--json'], { BABEL_CONFIG_DIR: dir })
    assert.equal(listed.status, 0, listed.stderr)
    const payload = JSON.parse(listed.stdout) as {
      count: number
      servers: Record<string, unknown>
    }
    assert.equal(payload.count, 0)
    assert.deepEqual(payload.servers, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mcp doctor --json and mcp list --json do not reveal configured arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-mcp-redaction-'))
  const sentinels = [
    'SYNTHETIC_W09_FLAG_SENTINEL',
    'SYNTHETIC_W09_URL_SENTINEL',
    'SYNTHETIC_W09_POSITIONAL_SENTINEL',
  ]
  writeFileSync(
    join(dir, 'mcp_servers.json'),
    JSON.stringify({
      servers: {
        demo: {
          command: 'node',
          args: [
            'server.js',
            '--example-setting',
            sentinels[0],
            '--db',
            `postgresql://user:${sentinels[1]}@localhost/db`,
            sentinels[2],
          ],
        },
      },
    }),
    'utf8',
  )

  try {
    for (const args of [
      ['mcp', 'doctor', '--json'],
      ['mcp', 'list', '--json'],
    ]) {
      const result = runCli(args, { BABEL_CONFIG_DIR: dir })
      assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`)
      for (const sentinel of sentinels) {
        assert.doesNotMatch(result.stdout, new RegExp(sentinel), args.join(' '))
      }
      assert.match(result.stdout, /"args_redacted": true/u, args.join(' '))
      assert.match(result.stdout, /"arg_count": 6/u, args.join(' '))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin JSON diagnostics and mcp add use the same redacted argument shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-mcp-redaction-plugins-'))
  const pluginDir = join(dir, 'plugins', 'redact-demo')
  const configDir = join(dir, 'config')
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const sentinel = 'SYNTHETIC_W09_PLUGIN_SENTINEL'
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      schema_version: 1,
      id: 'redact-demo',
      name: 'Redact Demo',
      version: '1.0.0',
      trust_level: 'read_only',
      tools: [],
      slash_commands: [],
      prompt_skills: [],
      mcp_servers: [
        { name: 'service', command: 'node', args: ['--token', sentinel] },
      ],
      hooks: [],
    }),
    'utf8',
  )
  writeFileSync(
    join(dir, 'plugins.json'),
    JSON.stringify({
      schema_version: 1,
      runtime_plugins_enabled: true,
      enabled_plugin_ids: ['redact-demo'],
      allowed_trust_levels: ['metadata', 'read_only'],
      plugin_roots: [],
      mcp_server_launch_consent: [],
    }),
    'utf8',
  )
  writeFileSync(join(configDir, 'mcp_servers.json'), JSON.stringify({ servers: {} }), 'utf8')
  const env = {
    BABEL_CONFIG_DIR: configDir,
    BABEL_PLUGINS_CONFIG: join(dir, 'plugins.json'),
    BABEL_PLUGIN_ROOTS: join(dir, 'plugins'),
  }

  try {
    for (const args of [
      ['plugins', 'list', '--json'],
      ['plugins', 'doctor', '--json'],
      ['plugins', 'inspect', 'redact-demo', '--json'],
      ['mcp', 'add', '--json', 'added', 'node', 'server.js', sentinel],
    ]) {
      const result = runCli(args, env)
      assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`)
      assert.doesNotMatch(result.stdout, new RegExp(sentinel), args.join(' '))
      assert.match(result.stdout, /"arg_count": 2/u, args.join(' '))
      assert.match(result.stdout, /"args_redacted": true/u, args.join(' '))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

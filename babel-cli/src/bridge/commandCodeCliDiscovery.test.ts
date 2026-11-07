import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  probeCommandCodeInstallation,
  resolveCommandCodeExecutable,
} from './commandCodeCliDiscovery.js';

describe('commandCodeCliDiscovery', () => {
  it('does not resolve project-local PATH shadow binaries under cwd', () => {
    const root = mkdtempSync(join(process.cwd(), '.babel-cc-discovery-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const executableName = process.platform === 'win32' ? 'cmd.exe' : 'cmd';
      const fake = join(binDir, executableName);
      writeFileSync(fake, process.platform === 'win32' ? '@echo off\r\necho 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n', 'utf8');
      if (process.platform !== 'win32') {
        chmodSync(fake, 0o755);
      }
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const resolved = resolveCommandCodeExecutable(`${binDir}${pathSep}/usr/bin:/bin`);
      assert.equal(resolved, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns missing when no executable is on PATH', async () => {
    const probe = await probeCommandCodeInstallation({
      pathEnv: '/empty',
      spawnFn: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    assert.equal(probe.state, 'missing');
    assert.equal(resolveCommandCodeExecutable('/empty'), undefined);
  });
});

it('does not treat the Windows command interpreter as Command Code', { skip: process.platform !== 'win32' }, () => {
  const systemDir = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
  assert.equal(resolveCommandCodeExecutable(systemDir), undefined)
})

it('resolves a Windows npm CommandCode shim to its contained Node entrypoint', { skip: process.platform !== 'win32' }, async () => {
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'babel-cc-npm-'))
  try {
    const packageRoot = join(root, 'node_modules', 'command-code'); mkdirSync(join(packageRoot, 'dist'), { recursive: true })
    writeFileSync(join(root, 'cmdc.ps1'), '# synthetic shim')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'command-code', bin: { cmdc: 'dist/index.mjs' } }))
    const entry = join(packageRoot, 'dist', 'index.mjs'); writeFileSync(entry, '// synthetic entry')
    assert.equal(resolveCommandCodeExecutable(root), entry)
    const probe = await probeCommandCodeInstallation({ pathEnv: root, spawnFn: async (exe, args) => {
      assert.equal(exe, entry); assert.deepEqual(args, ['--version']); return { exitCode: 0, stdout: '1.88.2', stderr: '' }
    } })
    assert.equal(probe.state, 'verified'); assert.equal(probe.version, '1.88.2')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('rejects an npm declaration that escapes its package root', { skip: process.platform !== 'win32' }, async () => {
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'babel-cc-escape-'))
  try {
    const packageRoot = join(root, 'node_modules', 'command-code'); mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(root, 'cmdc.ps1'), '# synthetic shim'); writeFileSync(join(root, 'outside.mjs'), '// outside')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'command-code', bin: { cmdc: '../../outside.mjs' } }))
    assert.equal(resolveCommandCodeExecutable(root), undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

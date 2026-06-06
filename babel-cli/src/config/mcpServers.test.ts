import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  filterAllowedMcpServers,
  filterEnterpriseMcpServers,
  isAllowedMcpServerCommand,
} from './mcpServers.js';

for (const command of ['npx', 'node', 'npm.cmd', 'python3', 'uvx', 'yarn.exe']) {
  test(`MCP command allowlist accepts ${command}`, () => {
    assert.equal(isAllowedMcpServerCommand(command), true);
  });
}

for (const command of [
  '',
  'powershell',
  'cmd.exe',
  'bash',
  'C:\\Windows\\System32\\cmd.exe',
  './server',
  '../server',
  'node --eval',
  'npm run',
]) {
  test(`MCP command allowlist rejects ${command || '<empty>'}`, () => {
    assert.equal(isAllowedMcpServerCommand(command), false);
  });
}

test('filterAllowedMcpServers drops unsafe server commands', () => {
  const filtered = filterAllowedMcpServers({
    safe: { command: 'npx', args: ['-y', '@example/server'] },
    unsafe: { command: 'powershell', args: ['-NoProfile'] },
  });

  assert.deepEqual(filtered, {
    safe: { command: 'npx', args: ['-y', '@example/server'] },
  });
});

test('filterEnterpriseMcpServers applies configured server allowlist', () => {
  const previousPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_PATH'];
  const previousUserPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
  const previousAdminPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
  const root = mkdtempSync(join(tmpdir(), 'babel-mcp-policy-'));
  const policyPath = join(root, 'enterprise-policy.json');
  writeFileSync(policyPath, JSON.stringify({
    schema_version: 1,
    allowed_mcp_servers: ['github'],
  }), 'utf8');

  process.env['BABEL_ENTERPRISE_POLICY_PATH'] = policyPath;
  process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = join(root, 'missing-user-policy.json');
  delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];

  try {
    const filtered = filterEnterpriseMcpServers({
      github: { command: 'npx', args: ['-y', '@example/github'] },
      sqlite: { command: 'npx', args: ['-y', '@example/sqlite'] },
    });

    assert.deepEqual(filtered, {
      github: { command: 'npx', args: ['-y', '@example/github'] },
    });
  } finally {
    if (previousPolicyPath === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_PATH'] = previousPolicyPath;
    if (previousUserPolicyPath === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = previousUserPolicyPath;
    if (previousAdminPolicyPath === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] = previousAdminPolicyPath;
  }
});

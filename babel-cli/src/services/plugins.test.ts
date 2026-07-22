import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  enablePlugin,
  handlePluginTool,
  loadPluginRegistry,
  runPluginCommand,
  runPluginHooks,
} from './plugins.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THIRD_PARTY_FIXTURE_ROOT = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'plugin-proofs', 'third-party-plugin-corpus');

function createTempBabelRoot(): string {
  const root = join(tmpdir(), `babel-plugin-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(root, 'babel-cli', 'config'), { recursive: true });
  mkdirSync(join(root, 'babel-cli', 'plugins'), { recursive: true });
  return root;
}

function writePlugin(root: string, id: string, manifest: Record<string, unknown>): void {
  const dir = join(root, 'babel-cli', 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function writeReadonlyPlugin(root: string): void {
  writePlugin(root, 'sample-readonly', {
    schema_version: 1,
    id: 'sample-readonly',
    name: 'Sample Readonly',
    version: '0.1.0',
    trust_level: 'read_only',
    tools: [
      {
        kind: 'static_json',
        name: 'plugin_status',
        description: 'Return plugin status.',
        payload: { ok: true },
      },
    ],
    slash_commands: [
      {
        kind: 'static_text',
        name: 'hello',
        description: 'Say hello.',
        text: 'hello {args}',
      },
    ],
    prompt_skills: [
      {
        id: 'sample_skill',
        title: 'Sample Skill',
        description: 'Sample skill.',
        content: 'Sample skill content.',
      },
    ],
    mcp_servers: [
      {
        name: 'sample',
        command: 'node',
        args: ['server.js'],
      },
    ],
    hooks: [],
  });
}

function writeFormatHookPlugin(root: string): void {
  writePlugin(root, 'sample-format-hook', {
    schema_version: 1,
    id: 'sample-format-hook',
    name: 'Sample Format Hook',
    version: '0.1.0',
    trust_level: 'local_mutating',
    tools: [],
    slash_commands: [],
    prompt_skills: [],
    mcp_servers: [],
    hooks: [
      {
        event: 'PostToolUse',
        tool: 'file_write',
        action: 'trim_trailing_whitespace',
        dry_run_supported: true,
      },
    ],
  });
}

function writeThirdPartyCorpusFixture(root: string, fixtureId: 'readonly' | 'local-mutating' | 'enterprise-blocked'): void {
  const manifest = JSON.parse(readFileSync(join(THIRD_PARTY_FIXTURE_ROOT, fixtureId, 'plugin.json'), 'utf-8')) as Record<string, unknown>;
  const pluginId = manifest.id;
  if (typeof pluginId !== 'string') {
    throw new Error('Third-party fixture plugin.id must be a string.');
  }
  writePlugin(root, pluginId, manifest);
}

function withEnterprisePolicy<T>(root: string, policy: Record<string, unknown>, fn: () => T): T {
  const previous = {
    explicit: process.env['BABEL_ENTERPRISE_POLICY_PATH'],
    user: process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'],
    admin: process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'],
  };
  const policyPath = join(root, 'enterprise-policy.json');
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');
  process.env['BABEL_ENTERPRISE_POLICY_PATH'] = policyPath;
  process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = join(root, 'missing-user-policy.json');
  delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];

  try {
    return fn();
  } finally {
    if (previous.explicit === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_PATH'] = previous.explicit;
    if (previous.user === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = previous.user;
    if (previous.admin === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] = previous.admin;
  }
}

test('third-party plugin corpus supports hook diff evidence for changed outputs', async () => {
  const root = createTempBabelRoot();
  writeThirdPartyCorpusFixture(root, 'local-mutating');

  enablePlugin('third-party-local-mutating', { babelRoot: root, allowTrust: 'local_mutating' });

  const projectRoot = join(root, 'project');
  const runDir = join(root, 'runs', 'plugin-hook-third-party');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'source.txt'), 'value  \nline\t\r\n', 'utf-8');

  const result = await runPluginHooks('PostToolUse', {
    runId: 'plugin-hook-third-party',
    runDir,
    babelRoot: root,
    projectRoot,
    dryRun: false,
    tool: { tool: 'file_write', path: 'source.txt' },
    toolResult: { exit_code: 0, stdout: 'ok', stderr: '' },
  }, { babelRoot: root });

  assert.equal(result.records.length, 1);
  const record = result.records[0] as {
    outcome?: {
      status?: string;
      before_hash?: string;
      after_hash?: string;
      changed_bytes?: number;
    };
  };
  const outcome = record.outcome as {
    status?: string;
    before_hash?: string;
    after_hash?: string;
    changed_bytes?: number;
  };
  assert.equal(outcome.status, 'changed');
  assert.equal(outcome.before_hash === outcome.after_hash, false);
  assert.equal(typeof outcome.changed_bytes, 'number');
  assert.equal(outcome.changed_bytes !== undefined && outcome.changed_bytes > 0, true);
  assert.equal(typeof outcome.before_hash, 'string');
  assert.equal(typeof outcome.after_hash, 'string');
});

test('third-party plugin corpora are blocked by enterprise policy when trust exceeds allowlist', () => {
  const root = createTempBabelRoot();
  writeThirdPartyCorpusFixture(root, 'enterprise-blocked');

  withEnterprisePolicy(root, {
    schema_version: 1,
    plugin_policy: {
      allowed_plugins: ['third-party-enterprise-blocked'],
      max_trust_level: 'read_only',
    },
  }, () => {
    writeFileSync(join(root, 'babel-cli', 'config', 'plugins.json'), JSON.stringify({
      schema_version: 1,
      runtime_plugins_enabled: true,
      enabled_plugin_ids: ['third-party-enterprise-blocked'],
      allowed_trust_levels: ['metadata', 'read_only', 'local_mutating', 'external_network'],
      plugin_roots: [],
    }, null, 2));

    assert.throws(
      () => enablePlugin('third-party-enterprise-blocked', { babelRoot: root }),
      /\[ENTERPRISE_POLICY\]/,
    );

    const registry = loadPluginRegistry({ babelRoot: root });
    const plugin = registry.plugins.find((candidate) => candidate.manifest.id === 'third-party-enterprise-blocked');
    assert.equal(plugin?.active, false);
    assert.equal(registry.diagnostics.some((diagnostic) => diagnostic.code === 'plugin_enterprise_policy_blocked'), true);
  });
});

test('runtime plugins are discovered but inactive until explicitly enabled', async () => {
  const root = createTempBabelRoot();
  writeReadonlyPlugin(root);

  const disabledRegistry = loadPluginRegistry({ babelRoot: root });
  assert.equal(disabledRegistry.config.runtime_plugins_enabled, false);
  assert.equal(disabledRegistry.plugins[0]?.active, false);

  const disabledCommand = await runPluginCommand('sample-readonly', 'hello', ['Example User'], { babelRoot: root });
  assert.equal(disabledCommand.exit_code, 1);
  assert.match(disabledCommand.stderr, /plugin_not_active/);

  enablePlugin('sample-readonly', { babelRoot: root });
  const enabledRegistry = loadPluginRegistry({ babelRoot: root });
  assert.equal(enabledRegistry.config.runtime_plugins_enabled, true);
  assert.equal(enabledRegistry.plugins[0]?.active, true);

  const command = await runPluginCommand('sample-readonly', 'hello', ['Example User'], { babelRoot: root });
  assert.equal(command.exit_code, 0);
  assert.equal(command.stdout, 'hello Example User');

  const tool = await handlePluginTool({
    tool: 'plugin_tool',
    plugin: 'sample-readonly',
    name: 'plugin_status',
    input: { probe: true },
  }, { babelRoot: root });
  assert.equal(tool.exit_code, 0);
  assert.equal(JSON.parse(tool.stdout).output.ok, true);
});

test('local-mutating hook plugins require explicit trust and can format live writes', async () => {
  const root = createTempBabelRoot();
  writeFormatHookPlugin(root);

  assert.throws(
    () => enablePlugin('sample-format-hook', { babelRoot: root }),
    /requires trust_level "local_mutating"/,
  );
  enablePlugin('sample-format-hook', { babelRoot: root, allowTrust: 'local_mutating' });

  const projectRoot = join(root, 'project');
  const runDir = join(root, 'runs', 'plugin-hook-live');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'file.txt'), 'alpha  \n beta\t\n', 'utf-8');

  const result = await runPluginHooks('PostToolUse', {
    runId: 'plugin-hook-live',
    runDir,
    babelRoot: root,
    projectRoot,
    dryRun: false,
    tool: { tool: 'file_write', path: 'file.txt' },
    toolResult: { exit_code: 0, stdout: 'Written: file.txt', stderr: '' },
  }, { babelRoot: root });

  assert.equal(result.records.length, 1);
  assert.equal(readFileSync(join(projectRoot, 'file.txt'), 'utf-8'), 'alpha\n beta\n');
  assert.equal(existsSync(join(runDir, '09_plugin_events.jsonl')), true);
});

test('format hook supports dry-run shadow roots without changing live files', async () => {
  const root = createTempBabelRoot();
  writeFormatHookPlugin(root);
  enablePlugin('sample-format-hook', { babelRoot: root, allowTrust: 'local_mutating' });

  const projectRoot = join(root, 'project');
  const shadowRoot = join(root, 'shadow');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(shadowRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'file.txt'), 'live  \n', 'utf-8');
  writeFileSync(join(shadowRoot, 'file.txt'), 'shadow  \n', 'utf-8');

  await runPluginHooks('PostToolUse', {
    runId: 'plugin-hook-dry',
    runDir: join(root, 'runs', 'plugin-hook-dry'),
    babelRoot: root,
    projectRoot,
    shadowRoot,
    dryRun: true,
    tool: { tool: 'file_write', path: 'file.txt' },
    toolResult: { exit_code: 0, stdout: 'Written: file.txt (shadowed)', stderr: '' },
  }, { babelRoot: root });

  assert.equal(readFileSync(join(projectRoot, 'file.txt'), 'utf-8'), 'live  \n');
  assert.equal(readFileSync(join(shadowRoot, 'file.txt'), 'utf-8'), 'shadow\n');
});

test('invalid plugin manifests produce structured diagnostics without throwing', () => {
  const root = createTempBabelRoot();
  const pluginDir = join(root, 'babel-cli', 'plugins', 'bad');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), '{"schema_version": 1, "id": 42}', 'utf-8');

  const registry = loadPluginRegistry({ babelRoot: root });
  assert.equal(registry.status, 'fail');
  assert.equal(registry.diagnostics[0]?.code, 'invalid_manifest');
});

test('plugin doctor warns on duplicate manifest surface names', () => {
  const root = createTempBabelRoot();
  writePlugin(root, 'duplicate-surfaces', {
    schema_version: 1,
    id: 'duplicate-surfaces',
    name: 'Duplicate Surfaces',
    version: '0.1.0',
    trust_level: 'read_only',
    tools: [
      {
        kind: 'static_text',
        name: 'status',
        description: 'First status tool.',
        text: 'one',
      },
      {
        kind: 'static_text',
        name: 'status',
        description: 'Second status tool.',
        text: 'two',
      },
    ],
    slash_commands: [
      {
        kind: 'static_text',
        name: 'hello',
        description: 'First hello command.',
        text: 'hello',
      },
      {
        kind: 'static_text',
        name: 'hello',
        description: 'Second hello command.',
        text: 'hello again',
      },
    ],
    prompt_skills: [],
    mcp_servers: [],
    hooks: [],
  });

  const registry = loadPluginRegistry({ babelRoot: root });
  const duplicates = registry.diagnostics.filter((diagnostic) => diagnostic.code === 'duplicate_plugin_surface');
  assert.equal(registry.status, 'warn');
  assert.equal(duplicates.length, 2);
  assert.match(duplicates.map((diagnostic) => diagnostic.message).join('\n'), /duplicate tool name "status"/);
  assert.match(duplicates.map((diagnostic) => diagnostic.message).join('\n'), /duplicate slash_command name "hello"/);
});

test('enterprise plugin policy blocks disallowed trust levels and activation', () => {
  const root = createTempBabelRoot();
  writeReadonlyPlugin(root);
  writeFormatHookPlugin(root);

  withEnterprisePolicy(root, {
    schema_version: 1,
    plugin_policy: {
      allowed_plugins: ['sample-readonly', 'sample-format-hook'],
      max_trust_level: 'read_only',
    },
  }, () => {
    enablePlugin('sample-readonly', { babelRoot: root });
    assert.throws(
      () => enablePlugin('sample-format-hook', { babelRoot: root, allowTrust: 'local_mutating' }),
      /ENTERPRISE_POLICY/,
    );

    writeFileSync(join(root, 'babel-cli', 'config', 'plugins.json'), JSON.stringify({
      schema_version: 1,
      runtime_plugins_enabled: true,
      enabled_plugin_ids: ['sample-format-hook'],
      allowed_trust_levels: ['metadata', 'read_only', 'local_mutating'],
      plugin_roots: [],
    }, null, 2), 'utf-8');

    const registry = loadPluginRegistry({ babelRoot: root });
    const plugin = registry.plugins.find((candidate) => candidate.manifest.id === 'sample-format-hook');
    assert.equal(plugin?.active, false);
    assert.equal(registry.diagnostics.some((diagnostic) => diagnostic.code === 'plugin_enterprise_policy_blocked'), true);
  });
});

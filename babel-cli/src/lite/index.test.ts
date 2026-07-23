import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import { LiteError, loadLiteRuntimeConfig, selectLiteProviderConfig } from './config.js';
import { buildLiteTaskContract } from './contract.js';
import { runLiteAsk, runLitePatch, runLitePlan, runLiteProviders } from './commands.js';

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-repo-'));
  mkdirSync(join(root, 'src', 'lite'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# Agent rules\n', 'utf-8');
  writeFileSync(join(root, 'PROJECT_CONTEXT.md'), '# Project context\n', 'utf-8');
  writeFileSync(join(root, 'README.md'), '# Fixture\n', 'utf-8');
  writeFileSync(
    join(root, 'src', 'lite', 'provider.ts'),
    'export const provider = true;\n',
    'utf-8',
  );
  writeFileSync(join(root, 'src', 'privacyish-note.ts'), 'export const note = true;\n', 'utf-8');
  writeFileSync(join(root, 'src', 'unrelated.ts'), 'export const unrelated = true;\n', 'utf-8');
  writeFileSync(join(root, 'config', 'model-policy.json'), '{}\n', 'utf-8');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'node --test',
          build: 'tsc',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  return root;
}

function snapshotRepoFiles(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'runs') {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile()) {
        snapshot[relative(root, fullPath).replace(/\\/g, '/')] = readFileSync(fullPath, 'utf-8');
      }
    }
  };

  visit(root);
  return snapshot;
}

test('lite provider config uses requested env keys, model overrides, and auto refuses absent live providers', () => {
  const config = loadLiteRuntimeConfig({
    DEEPSEEK_API_KEY: 'deepseek-secret',
    DEEPINFRA_TOKEN: 'deepinfra-token',
    DEEPINFRA_API_KEY: 'deepinfra-legacy-secret',
    BABEL_LITE_DEEPSEEK_MODEL: 'deepseek-v4-pro',
  });

  assert.equal(config.providers.deepseek.configured, true);
  assert.equal(config.providers.deepseek.primaryEnvKeyName, 'DEEPSEEK_API_KEY');
  assert.equal(config.providers.deepseek.defaultModel, 'deepseek-v4-pro');
  assert.equal(config.providers.deepinfra.configured, true);
  assert.equal(config.providers.deepinfra.primaryEnvKeyName, 'DEEPINFRA_TOKEN');
  assert.deepEqual(config.providers.deepinfra.fallbackEnvKeyNames, ['DEEPINFRA_API_KEY']);
  assert.equal(config.providers.deepinfra.activeEnvKeyName, 'DEEPINFRA_TOKEN');
  assert.equal(selectLiteProviderConfig('auto', config).id, 'deepseek');

  const fallbackConfig = loadLiteRuntimeConfig({
    DEEPINFRA_API_KEY: 'legacy-only',
  });
  assert.equal(fallbackConfig.providers.deepinfra.configured, true);
  assert.equal(fallbackConfig.providers.deepinfra.activeEnvKeyName, 'DEEPINFRA_API_KEY');

  const emptyConfig = loadLiteRuntimeConfig({});
  assert.throws(
    () => selectLiteProviderConfig('deepseek', emptyConfig),
    (error: unknown) => error instanceof LiteError && error.code === 'PROVIDER_KEY_MISSING',
  );
  assert.throws(
    () => selectLiteProviderConfig('auto', emptyConfig),
    (error: unknown) => error instanceof LiteError && error.code === 'PROVIDER_KEY_MISSING',
  );
});

test('lite direct DeepSeek config rejects unsupported model overrides', async () => {
  assert.throws(
    () =>
      loadLiteRuntimeConfig({
        DEEPSEEK_API_KEY: 'deepseek-secret',
        BABEL_LITE_DEEPSEEK_MODEL: 'deepseek-chat',
      }),
    (error: unknown) =>
      error instanceof LiteError &&
      error.code === 'PROVIDER_UNKNOWN' &&
      error.message.includes('deepseek-v4-flash'),
  );

  await assert.rejects(
    () =>
      runLiteAsk({
        repoPath: createFixtureRepo(),
        task: 'Explain provider model validation',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        env: { DEEPSEEK_API_KEY: 'deepseek-secret' },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'should not call provider' } }],
            }),
            { status: 200 },
          ),
      }),
    (error: unknown) =>
      error instanceof LiteError &&
      error.code === 'PROVIDER_UNKNOWN' &&
      error.message.includes('deepseek-v4-pro'),
  );
});

test('providers status reports key presence without secret values and exposes stable schema', () => {
  const result = runLiteProviders({
    DEEPSEEK_API_KEY: 'secret-value',
  });

  const deepseek = result.providers.find((provider) => provider.id === 'deepseek');
  assert.equal(result.schema_version, 1);
  assert.equal(result.command, 'providers');
  assert.equal(deepseek?.configured, true);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.ok(result.failure_codes.includes('PROVIDER_KEY_MISSING'));
});

test('plan produces compact contract with likely and suspected files separated', () => {
  const repoPath = createFixtureRepo();
  const before = snapshotRepoFiles(repoPath);
  const result = runLitePlan({
    repoPath,
    task: 'Lite provider config model',
    now: new Date('2026-05-25T12:00:00.000Z'),
    env: {},
  });
  const after = snapshotRepoFiles(repoPath);

  assert.deepEqual(after, before);
  assert.equal(result.schema_version, 1);
  assert.equal(result.command, 'plan');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.contract.mode, 'babel-lite-plan');
  assert.ok(result.contract.budget.estimated_prompt_tokens <= 2500);
  assert.ok(result.contract.required_reads.includes('AGENTS.md'));
  assert.ok(result.contract.verification_candidates.includes('npm run typecheck'));
  assert.ok(result.contract.likely_files.includes('src/lite/provider.ts'));
  assert.ok(result.contract.likely_files.includes('config/model-policy.json'));
  assert.ok(result.contract.suspected_files.includes('PROJECT_CONTEXT.md'));
  assert.equal(existsSync(join(repoPath, 'runs', 'babel-lite')), false);
});

test('risk router keeps protected provider, integration, MCP, Codex, risk, security, privacy, and API tasks out of Lite', () => {
  const repoPath = createFixtureRepo();
  const tasks = [
    'Add MCP integration docs',
    'Review privacy redaction for external providers',
    'Harden Codex security risk checks',
    'Audit API fallback risks',
    'Update DeepInfra adapters',
    'Document provider privacy behavior',
  ];

  for (const task of tasks) {
    const result = runLitePlan({
      repoPath,
      task,
      env: {},
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    assert.notEqual(result.contract.risk_lane, 'Lite', `${task} should not classify as Lite`);
  }
});

test('weak file-name matches are suspected, not likely, and truncated scans emit warnings', () => {
  const repoPath = createFixtureRepo();
  const contract = buildLiteTaskContract({
    repoPath,
    task: 'Plan privacy handling',
    maxPromptTokens: 2500,
    now: new Date('2026-05-25T12:00:00.000Z'),
  });

  assert.equal(contract.likely_files.includes('src/privacyish-note.ts'), false);
  assert.ok(contract.suspected_files.includes('src/privacyish-note.ts'));

  const truncated = buildLiteTaskContract({
    repoPath,
    task: 'Plan privacy handling',
    maxPromptTokens: 2500,
    fileScanLimit: 2,
    now: new Date('2026-05-25T12:00:00.000Z'),
  });

  assert.equal(truncated.repo.scanTruncated, true);
  assert.ok(truncated.warnings.some((warning) => warning.includes('Repo scan truncated')));
});

test('broad governance terms do not promote loosely related files to likely files', () => {
  const repoPath = createFixtureRepo();
  mkdirSync(join(repoPath, '03_Model_Adapters'), { recursive: true });
  mkdirSync(join(repoPath, '02_Skills', 'Governance'), { recursive: true });
  writeFileSync(join(repoPath, '03_Model_Adapters', 'Codex_Balanced.md'), '# Codex\n', 'utf-8');
  writeFileSync(
    join(repoPath, '02_Skills', 'Governance', 'Public-Export-Hardening-v1.md'),
    '# Hardening\n',
    'utf-8',
  );
  writeFileSync(
    join(repoPath, 'src', 'lite', 'redaction.ts'),
    'export const redaction = true;\n',
    'utf-8',
  );

  const result = runLitePlan({
    repoPath,
    task: 'Design privacy hardening for Codex MCP provider integration redaction',
    now: new Date('2026-05-25T12:00:00.000Z'),
    env: {},
  });

  assert.ok(result.contract.likely_files.includes('src/lite/redaction.ts'));
  assert.equal(
    result.contract.likely_files.includes('03_Model_Adapters/Codex_Balanced.md'),
    false,
  );
  assert.equal(
    result.contract.likely_files.includes('02_Skills/Governance/Public-Export-Hardening-v1.md'),
    false,
  );
  assert.ok(result.contract.suspected_files.includes('03_Model_Adapters/Codex_Balanced.md'));
  assert.ok(
    result.contract.suspected_files.includes('02_Skills/Governance/Public-Export-Hardening-v1.md'),
  );
});

test('prompt budget enforcement fails closed when the cap is impossible', () => {
  const repoPath = createFixtureRepo();

  assert.throws(
    () =>
      buildLiteTaskContract({
        repoPath,
        task: 'Explain a small task',
        maxPromptTokens: 25,
        now: new Date('2026-05-25T12:00:00.000Z'),
      }),
    (error: unknown) => error instanceof LiteError && error.code === 'PROMPT_BUDGET_EXCEEDED',
  );
});

test('repo and task validation use stable failure codes', async () => {
  assert.throws(
    () =>
      runLitePlan({
        repoPath: join(tmpdir(), 'missing-babel-lite-repo'),
        task: 'Explain the test strategy',
        env: {},
      }),
    (error: unknown) => error instanceof LiteError && error.code === 'REPO_NOT_FOUND',
  );
  assert.throws(
    () =>
      runLitePlan({
        repoPath: createFixtureRepo(),
        task: '   ',
        env: {},
      }),
    (error: unknown) => error instanceof LiteError && error.code === 'TASK_REQUIRED',
  );
  await assert.rejects(
    () =>
      runLiteAsk({
        repoPath: createFixtureRepo(),
        task: 'Explain provider selection',
        provider: 'missing',
        env: {},
      }),
    (error: unknown) => error instanceof LiteError && error.code === 'PROVIDER_UNKNOWN',
  );
});

test('ask uses mock provider, supports model override, and saves required artifacts only under runs/babel-lite', async () => {
  const repoPath = createFixtureRepo();
  const before = snapshotRepoFiles(repoPath);
  const result = await runLiteAsk({
    repoPath,
    task: 'Explain the test strategy',
    provider: 'mock',
    model: 'mock-override-model',
    artifactRoot: join(repoPath, 'runs', 'babel-lite'),
    now: new Date('2026-05-25T12:00:00.000Z'),
    env: {},
  });
  const after = snapshotRepoFiles(repoPath);

  assert.deepEqual(after, before);
  assert.equal(result.schema_version, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.provider.id, 'mock');
  assert.equal(result.provider.model, 'mock-override-model');
  assert.equal(result.provider.privacy, 'redacted');
  assert.match(result.response, /MOCK ASK RESPONSE/);
  assert.match(result.artifacts.run_id, /^20260525T120000Z-ask-[a-z0-9-]+$/);
  assert.equal(
    relative(repoPath, result.artifacts.run_dir).replace(/\\/g, '/').startsWith('runs/babel-lite/'),
    true,
  );
  for (const name of [
    'contract.json',
    'prompt.md',
    'response.md',
    'provider.json',
    'cost_ledger.json',
  ]) {
    assert.ok(existsSync(result.artifacts.files[name] ?? ''), `${name} should exist`);
  }

  await assert.rejects(
    () =>
      runLiteAsk({
        repoPath,
        task: 'Try to write outside the repo artifact root',
        provider: 'mock',
        artifactRoot: join(tmpdir(), 'runs', 'babel-lite'),
        env: {},
      }),
    (error: unknown) => error instanceof LiteError && error.code === 'ARTIFACT_WRITE_FAILED',
  );
});

test('external provider payload privacy defaults to redacted and full mode is explicit', async () => {
  const repoPath = createFixtureRepo();
  const bodies: string[] = [];
  const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(String(init?.body ?? ''));
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: 'provider response with DEEPSEEK_API_KEY=response-secret' } },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      }),
      { status: 200 },
    );
  };

  const redacted = await runLiteAsk({
    repoPath,
    task: 'Explain DEEPSEEK_API_KEY=task-secret for fixture',
    provider: 'deepseek',
    artifactRoot: join(repoPath, 'runs', 'babel-lite'),
    env: { DEEPSEEK_API_KEY: 'provider-key' },
    fetchImpl,
  });
  assert.equal(redacted.provider.privacy, 'redacted');
  assert.doesNotMatch(redacted.response, /response-secret/);
  assert.doesNotMatch(bodies[0] ?? '', /task-secret/);
  const redactedLedger = JSON.parse(
    readFileSync(redacted.artifacts.files['cost_ledger.json'] ?? '', 'utf-8'),
  ) as {
    artifact_type?: string;
    schema_version?: number;
    pricing_mode?: string;
    totals?: { total_tokens?: number; estimated_cost_usd?: number };
    entries?: Array<{ cost_precision?: string; pricing_source_url?: string | null }>;
  };
  assert.equal(redactedLedger.artifact_type, 'babel_cost_ledger');
  assert.equal(redactedLedger.schema_version, 1);
  assert.equal(redactedLedger.pricing_mode, 'pinned_runtime_rates');
  assert.equal(redactedLedger.totals?.total_tokens, 13);
  assert.ok(typeof redactedLedger.totals?.estimated_cost_usd === 'number');
  assert.equal(redactedLedger.entries?.[0]?.cost_precision, 'conservative');
  assert.match(redactedLedger.entries?.[0]?.pricing_source_url ?? '', /deepseek/i);

  const full = await runLiteAsk({
    repoPath,
    task: 'Explain DEEPSEEK_API_KEY=full-mode-secret for fixture',
    provider: 'deepseek',
    privacy: 'full',
    artifactRoot: join(repoPath, 'runs', 'babel-lite'),
    env: { DEEPSEEK_API_KEY: 'provider-key' },
    fetchImpl,
  });
  assert.equal(full.provider.privacy, 'full');
  assert.doesNotMatch(full.response, /response-secret/);
  assert.match(bodies[1] ?? '', /full-mode-secret/);

  for (const artifactPath of Object.values(full.artifacts.files)) {
    assert.doesNotMatch(readFileSync(artifactPath, 'utf-8'), /full-mode-secret|provider-key/);
  }
});

test('provider failures map to stable Lite failure codes without live API calls', async () => {
  const repoPath = createFixtureRepo();

  await assert.rejects(
    () =>
      runLiteAsk({
        repoPath,
        task: 'Explain rate limit behavior',
        provider: 'deepseek',
        artifactRoot: join(repoPath, 'runs', 'babel-lite'),
        env: { DEEPSEEK_API_KEY: 'provider-key' },
        fetchImpl: async () =>
          new Response('slow down DEEPSEEK_API_KEY=rate-secret', { status: 429 }),
      }),
    (error: unknown) =>
      error instanceof LiteError &&
      error.code === 'PROVIDER_RATE_LIMITED' &&
      !error.message.includes('rate-secret'),
  );

  await assert.rejects(
    () =>
      runLiteAsk({
        repoPath,
        task: 'Explain http error behavior',
        provider: 'deepseek',
        artifactRoot: join(repoPath, 'runs', 'babel-lite'),
        env: { DEEPSEEK_API_KEY: 'provider-key' },
        fetchImpl: async () =>
          new Response('bad gateway DEEPSEEK_API_KEY=http-secret', { status: 502 }),
      }),
    (error: unknown) =>
      error instanceof LiteError &&
      error.code === 'PROVIDER_HTTP_ERROR' &&
      !error.message.includes('http-secret'),
  );

  await assert.rejects(
    () =>
      runLiteAsk({
        repoPath,
        task: 'Explain request error behavior',
        provider: 'deepseek',
        artifactRoot: join(repoPath, 'runs', 'babel-lite'),
        env: { DEEPSEEK_API_KEY: 'provider-key' },
        fetchImpl: async () => {
          throw new Error('network failed DEEPSEEK_API_KEY=request-secret');
        },
      }),
    (error: unknown) =>
      error instanceof LiteError &&
      error.code === 'PROVIDER_REQUEST_FAILED' &&
      !error.message.includes('request-secret'),
  );

  await assert.rejects(
    () =>
      runLiteAsk({
        repoPath,
        task: 'Explain empty response behavior',
        provider: 'deepseek',
        artifactRoot: join(repoPath, 'runs', 'babel-lite'),
        env: { DEEPSEEK_API_KEY: 'provider-key' },
        fetchImpl: async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
            status: 200,
          }),
      }),
    (error: unknown) => error instanceof LiteError && error.code === 'PROVIDER_EMPTY_RESPONSE',
  );
});

test('patch uses mock provider, writes diff artifact, refuses auto-apply, and leaves repo files unchanged', async () => {
  const repoPath = createFixtureRepo();
  const before = snapshotRepoFiles(repoPath);
  const result = await runLitePatch({
    repoPath,
    task: 'Propose a patch for the fixture',
    provider: 'mock',
    artifactRoot: join(repoPath, 'runs', 'babel-lite'),
    now: new Date('2026-05-25T12:00:00.000Z'),
    env: {},
  });
  const after = snapshotRepoFiles(repoPath);

  assert.deepEqual(after, before);
  assert.equal(result.schema_version, 1);
  assert.equal(result.auto_apply, false);
  assert.match(result.patch, /MOCK PATCH PROPOSAL/);
  const patchPath = result.artifacts.files['patch.diff'] ?? '';
  assert.ok(existsSync(patchPath));
  assert.equal(statSync(join(repoPath, 'src', 'lite', 'provider.ts')).isFile(), true);
  assert.match(readFileSync(patchPath, 'utf-8'), /not applied/i);

  await assert.rejects(
    () =>
      runLitePatch({
        repoPath,
        task: 'Try to apply a patch',
        provider: 'mock',
        autoApply: true,
        env: {},
      }),
    (error: unknown) => error instanceof LiteError && error.code === 'PATCH_AUTO_APPLY_REFUSED',
  );
});

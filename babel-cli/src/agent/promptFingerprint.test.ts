import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildPromptFingerprint,
  collectChatEnvFlags,
  isSecretKeyName,
  isSecretLookingValue,
  sha256Prefix,
} from './promptFingerprint.js';
import type { PromptFingerprint } from './promptFingerprint.js';
import { getChatTaskTune, type ChatTaskClass } from '../config/chatTaskClass.js';

function fakeEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

describe('promptFingerprint', () => {
  // ── sha256Prefix ───────────────────────────────────────────────────────

  test('sha256Prefix produces stable 16-char hex', () => {
    const a = sha256Prefix('hello world');
    const b = sha256Prefix('hello world');
    assert.equal(a, b);
    assert.equal(a.length, 16);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  test('sha256Prefix differs for different input', () => {
    const a = sha256Prefix('hello world');
    const b = sha256Prefix('hello world!');
    assert.notEqual(a, b);
  });

  // ── isSecretKeyName ────────────────────────────────────────────────────

  test('isSecretKeyName flags KEY/TOKEN/SECRET/PASSWORD', () => {
    assert.equal(isSecretKeyName('BABEL_CHAT_API_KEY'), true);
    assert.equal(isSecretKeyName('BABEL_CHAT_TOKEN'), true);
    assert.equal(isSecretKeyName('BABEL_CHAT_SECRET'), true);
    assert.equal(isSecretKeyName('BABEL_CHAT_PASSWORD'), true);
    assert.equal(isSecretKeyName('BABEL_CHAT_api_key'), true); // case-insensitive
  });

  test('isSecretKeyName allows non-secret names', () => {
    assert.equal(isSecretKeyName('BABEL_CHAT_MODEL'), false);
    assert.equal(isSecretKeyName('BABEL_CHAT_MAX_TURNS'), false);
    assert.equal(isSecretKeyName('BABEL_CHAT_TASK_CLASS'), false);
    assert.equal(isSecretKeyName('BABEL_CHAT_INVESTIGATE_MODEL'), false);
  });

  // ── isSecretLookingValue ───────────────────────────────────────────────

  test('isSecretLookingValue catches known prefixes', () => {
    assert.equal(isSecretLookingValue('sk-abc123def456'), true);
    assert.equal(isSecretLookingValue('api-xyz789'), true);
    assert.equal(isSecretLookingValue('dsk-abcdef'), true);
    assert.equal(isSecretLookingValue('ghp_1234567890abcdef'), true);
  });

  test('isSecretLookingValue catches JWT-like tokens', () => {
    assert.equal(
      isSecretLookingValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3E9NN56AkP_ZjW0'),
      true,
    );
  });

  test('isSecretLookingValue catches long base64-like strings', () => {
    assert.equal(
      isSecretLookingValue('YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwYWJjZGVmZ2hpams='),
      true,
    );
  });

  test('isSecretLookingValue allows short values and flags', () => {
    assert.equal(isSecretLookingValue('1'), false);
    assert.equal(isSecretLookingValue('deepseek-v4-flash'), false);
    assert.equal(isSecretLookingValue('true'), false);
    assert.equal(isSecretLookingValue('general_swe'), false);
    assert.equal(isSecretLookingValue('250'), false);
  });

  // ── collectChatEnvFlags ────────────────────────────────────────────────

  test('collectChatEnvFlags collects only BABEL_CHAT_* vars', () => {
    const env = fakeEnv({
      BABEL_CHAT_MODEL: 'deepseek-v4-pro',
      BABEL_CHAT_MAX_TURNS: '250',
      BABEL_CHAT_TASK_CLASS: 'general_swe',
      NODE_ENV: 'test',
      HOME: '/var/tmp/user',
      BABEL_HEADLESS: '1',
    });
    const flags = collectChatEnvFlags(env);
    assert.deepStrictEqual(Object.keys(flags).sort(), [
      'BABEL_CHAT_MAX_TURNS',
      'BABEL_CHAT_MODEL',
      'BABEL_CHAT_TASK_CLASS',
    ]);
  });

  test('collectChatEnvFlags redacts secret-looking values', () => {
    const env = fakeEnv({
      BABEL_CHAT_MODEL: 'deepseek-v4-pro',
      BABEL_CHAT_MAX_TURNS: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwYWJjZGVmZ2hpams=',
    });
    const flags = collectChatEnvFlags(env);
    assert.equal(flags['BABEL_CHAT_MODEL'], 'deepseek-v4-pro');
    assert.equal(flags['BABEL_CHAT_MAX_TURNS'], '[redacted]');
  });

  test('collectChatEnvFlags skips secret key names entirely', () => {
    const env = fakeEnv({
      BABEL_CHAT_MODEL: 'deepseek-v4-flash',
      BABEL_CHAT_API_KEY: 'api-key-fixture-value-here-12345',
      BABEL_CHAT_TOKEN: 'some-jwt-token',
    });
    const flags = collectChatEnvFlags(env);
    // API_KEY and TOKEN should be absent entirely
    assert.equal('BABEL_CHAT_API_KEY' in flags, false);
    assert.equal('BABEL_CHAT_TOKEN' in flags, false);
    assert.equal(flags['BABEL_CHAT_MODEL'], 'deepseek-v4-flash');
  });

  // ── buildPromptFingerprint ─────────────────────────────────────────────

  test('different task class → different fingerprint', () => {
    const systemPrompt = 'You are a coding agent.';
    const a = buildPromptFingerprint({
      systemPrompt,
      taskClass: 'general_swe',
      tune: getChatTaskTune('general_swe'),
      env: fakeEnv({}),
    });
    const b = buildPromptFingerprint({
      systemPrompt,
      taskClass: 'investigate',
      tune: getChatTaskTune('investigate'),
      env: fakeEnv({}),
    });
    assert.notEqual(a.task_class, b.task_class);
    assert.notEqual(a.force_mutate_turns, b.force_mutate_turns);
    // Same system prompt → same hash
    assert.equal(a.system_prompt_sha256, b.system_prompt_sha256);
    assert.equal(a.phase_gated_tools, false);
    assert.equal(b.phase_gated_tools, true);
  });

  test('stable hash for same prompt', () => {
    const systemPrompt = 'You are a coding agent.\nProject: test-project';
    const a = buildPromptFingerprint({
      systemPrompt,
      taskClass: 'default',
      tune: getChatTaskTune('default'),
      env: fakeEnv({}),
    });
    const b = buildPromptFingerprint({
      systemPrompt,
      taskClass: 'default',
      tune: getChatTaskTune('default'),
      env: fakeEnv({}),
    });
    assert.equal(a.system_prompt_sha256, b.system_prompt_sha256);
  });

  test('different system prompt → different hash', () => {
    const a = buildPromptFingerprint({
      systemPrompt: 'Prompt A',
      taskClass: 'default',
      tune: getChatTaskTune('default'),
      env: fakeEnv({}),
    });
    const b = buildPromptFingerprint({
      systemPrompt: 'Prompt B',
      taskClass: 'default',
      tune: getChatTaskTune('default'),
      env: fakeEnv({}),
    });
    assert.notEqual(a.system_prompt_sha256, b.system_prompt_sha256);
  });

  test('no API keys in fingerprint object', () => {
    const env = fakeEnv({
      BABEL_CHAT_MODEL: 'deepseek-v4-pro',
      BABEL_CHAT_API_KEY: 'sk-very-secret-key-value',
      BABEL_CHAT_TOKEN: 'secret-jwt-token-here',
    });
    const fp = buildPromptFingerprint({
      systemPrompt: 'test prompt',
      taskClass: 'default',
      tune: getChatTaskTune('default'),
      env,
    });

    // Keys with secret names must be absent
    assert.equal('BABEL_CHAT_API_KEY' in fp.env_flags, false);
    assert.equal('BABEL_CHAT_TOKEN' in fp.env_flags, false);

    // No value in the fingerprint should contain the actual secret
    const fpJson = JSON.stringify(fp);
    assert.equal(fpJson.includes('sk-very-secret-key-value'), false);
    assert.equal(fpJson.includes('secret-jwt-token-here'), false);
  });

  test('fingerprint includes tune fields', () => {
    const tune = getChatTaskTune('quick_fix');
    const fp = buildPromptFingerprint({
      systemPrompt: 'test',
      taskClass: 'quick_fix',
      tune,
      env: fakeEnv({}),
    });
    assert.equal(fp.task_class, 'quick_fix');
    assert.equal(fp.phase_gated_tools, tune.phaseGatedToolsDefault);
    assert.equal(fp.zero_write_hard_stop, tune.zeroWriteHardStopTurns);
    assert.equal(fp.force_mutate_turns, tune.forceMutateTurns);
    assert.equal(fp.system_prompt_sha256.length, 16);
  });

  test('playbook_id is included when set', () => {
    const fp = buildPromptFingerprint({
      systemPrompt: 'test',
      taskClass: 'general_swe',
      tune: getChatTaskTune('general_swe'),
      playbookId: 'multi-file-swe',
      env: fakeEnv({}),
    });
    assert.equal(fp.playbook_id, 'multi-file-swe');
  });

  test('playbook_id is absent when null/undefined', () => {
    const fp1 = buildPromptFingerprint({
      systemPrompt: 'test',
      taskClass: 'default',
      tune: getChatTaskTune('default'),
      playbookId: null,
      env: fakeEnv({}),
    });
    assert.equal('playbook_id' in fp1, false);

    const fp2 = buildPromptFingerprint({
      systemPrompt: 'test',
      taskClass: 'default',
      tune: getChatTaskTune('default'),
      env: fakeEnv({}),
    });
    assert.equal('playbook_id' in fp2, false);
  });

  test('all task classes produce valid fingerprints', () => {
    const classes: ChatTaskClass[] = ['default', 'quick_fix', 'general_swe', 'investigate', 'governance'];
    const env = fakeEnv({
      BABEL_CHAT_MAX_TURNS: '40',
    });
    for (const tc of classes) {
      const tune = getChatTaskTune(tc);
      const fp = buildPromptFingerprint({
        systemPrompt: 'Test prompt for ' + tc,
        taskClass: tc,
        tune,
        env,
      });
      assert.equal(fp.task_class, tc);
      assert.equal(typeof fp.phase_gated_tools, 'boolean');
      assert.equal(typeof fp.zero_write_hard_stop, 'number');
      assert.equal(typeof fp.force_mutate_turns, 'number');
      assert.equal(typeof fp.system_prompt_sha256, 'string');
      assert.equal(fp.system_prompt_sha256.length, 16);
      assert.equal(typeof fp.env_flags, 'object');
    }
  });

  test('env_flags handles BABEL_CHAT_INVESTIGATE_MODEL and MUTATE_MODEL safely', () => {
    const env = fakeEnv({
      BABEL_CHAT_INVESTIGATE_MODEL: 'deepseek-v4-flash',
      BABEL_CHAT_MUTATE_MODEL: 'deepseek-v4-pro',
    });
    const flags = collectChatEnvFlags(env);
    assert.equal(flags['BABEL_CHAT_INVESTIGATE_MODEL'], 'deepseek-v4-flash');
    assert.equal(flags['BABEL_CHAT_MUTATE_MODEL'], 'deepseek-v4-pro');
    // Neither contains "KEY", "TOKEN", "SECRET", or "PASSWORD"
    assert.equal(isSecretKeyName('BABEL_CHAT_INVESTIGATE_MODEL'), false);
    assert.equal(isSecretKeyName('BABEL_CHAT_MUTATE_MODEL'), false);
  });

  test('fingerprint structure matches brief schema', () => {
    const fp = buildPromptFingerprint({
      systemPrompt: 'test prompt',
      taskClass: 'general_swe',
      tune: getChatTaskTune('general_swe'),
      playbookId: 'test-playbook',
      env: fakeEnv({ BABEL_CHAT_MAX_TURNS: '250' }),
    });
    // Verify all required fields per brief §6 B4 type shape
    assert.ok(typeof fp.task_class === 'string');
    assert.ok(typeof fp.phase_gated_tools === 'boolean');
    assert.ok(typeof fp.zero_write_hard_stop === 'number');
    assert.ok(typeof fp.force_mutate_turns === 'number');
    assert.ok(typeof fp.system_prompt_sha256 === 'string');
    assert.equal(fp.system_prompt_sha256.length, 16);
    assert.ok(fp.playbook_id !== undefined);
    assert.ok(typeof fp.env_flags === 'object');
    assert.ok(typeof fp.env_flags['BABEL_CHAT_MAX_TURNS'] === 'string');
  });
});

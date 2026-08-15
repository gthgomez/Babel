import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUTONOMY_CLASSES,
  AUTONOMY_PROFILES,
  autonomyClassFromEnv,
  autonomyTaskClassFor,
  classifyAutonomyAction,
  parseAutonomyClass,
  resolveAutonomyOverride,
} from './autonomyPolicy.js';
import { resolveChatTaskClass } from './chatTaskClass.js';

describe('autonomyPolicy', () => {
  test('taxonomy is exactly A–D', () => {
    assert.deepEqual(AUTONOMY_CLASSES, ['A', 'B', 'C', 'D']);
    for (const cls of AUTONOMY_CLASSES) {
      const p = AUTONOMY_PROFILES[cls];
      assert.equal(p.class, cls);
      assert.ok(p.title.length > 0);
      assert.ok(p.description.length > 0);
      assert.ok(p.enforcement.length > 0);
    }
  });

  test('parseAutonomyClass accepts A–D case-insensitively', () => {
    assert.equal(parseAutonomyClass('A'), 'A');
    assert.equal(parseAutonomyClass('a'), 'A');
    assert.equal(parseAutonomyClass(' B '), 'B');
    assert.equal(parseAutonomyClass('D'), 'D');
    assert.equal(parseAutonomyClass('E'), null);
    assert.equal(parseAutonomyClass(''), null);
    assert.equal(parseAutonomyClass(undefined), null);
    assert.equal(parseAutonomyClass(null), null);
  });

  test('autonomyClassFromEnv reads BABEL_AUTONOMY_CLASS', () => {
    assert.equal(autonomyClassFromEnv({ BABEL_AUTONOMY_CLASS: 'C' }), 'C');
    assert.equal(autonomyClassFromEnv({ BABEL_AUTONOMY_CLASS: 'c' }), 'C');
    assert.equal(autonomyClassFromEnv({}), null);
    assert.equal(autonomyClassFromEnv({ BABEL_AUTONOMY_CLASS: '' }), null);
    // Fail-closed: set-but-invalid throws (a typo must not silently degrade a
    // Class-D session to default tuning).
    assert.throws(() => autonomyClassFromEnv({ BABEL_AUTONOMY_CLASS: 'garbage' }));
    assert.throws(() => autonomyClassFromEnv({ BABEL_AUTONOMY_CLASS: 'Z' }));
  });

  test('profiles map A–D onto native Babel primitives', () => {
    // A: autonomous by default — default tune, soft verification.
    assert.equal(AUTONOMY_PROFILES.A.mapsToTaskClass, 'default');
    assert.equal(AUTONOMY_PROFILES.A.verification, 'required');
    assert.equal(AUTONOMY_PROFILES.A.preset, 'workspace_write');
    assert.equal(AUTONOMY_PROFILES.A.approvalMode, 'auto');
    assert.equal(AUTONOMY_PROFILES.A.mutationPolicy, 'enabled');
    // B: autonomous with automatic verification — general_swe, strict critic.
    assert.equal(AUTONOMY_PROFILES.B.mapsToTaskClass, 'general_swe');
    assert.equal(AUTONOMY_PROFILES.B.verification, 'required');
    assert.equal(AUTONOMY_PROFILES.B.strictCritic, true);
    assert.equal(AUTONOMY_PROFILES.B.preset, 'workspace_write');
    // C: explicit gate — governance, strict verification, ask-before-mutation.
    assert.equal(AUTONOMY_PROFILES.C.mapsToTaskClass, 'governance');
    assert.equal(AUTONOMY_PROFILES.C.verification, 'strict');
    assert.equal(AUTONOMY_PROFILES.C.preset, 'ask_before_mutation');
    assert.equal(AUTONOMY_PROFILES.C.approvalMode, 'ask');
    assert.equal(AUTONOMY_PROFILES.C.mutationPolicy, 'ask');
    assert.equal(AUTONOMY_PROFILES.C.phaseGatedTools, true);
    assert.equal(AUTONOMY_PROFILES.C.restrictToolsOnPolicyFire, true);
    // D: never without exceptional instruction — mutations deterministically denied.
    assert.equal(AUTONOMY_PROFILES.D.mapsToTaskClass, 'governance');
    assert.equal(AUTONOMY_PROFILES.D.verification, 'strict');
    assert.equal(AUTONOMY_PROFILES.D.preset, 'read_only');
    assert.equal(AUTONOMY_PROFILES.D.approvalMode, 'deny');
    assert.equal(AUTONOMY_PROFILES.D.mutationPolicy, 'denied');
  });

  test('autonomyTaskClassFor maps A–D to task classes', () => {
    assert.equal(autonomyTaskClassFor('A'), 'default');
    assert.equal(autonomyTaskClassFor('B'), 'general_swe');
    assert.equal(autonomyTaskClassFor('C'), 'governance');
    assert.equal(autonomyTaskClassFor('D'), 'governance');
  });

  test('resolveAutonomyOverride returns class + profile + task class', () => {
    const override = resolveAutonomyOverride({ BABEL_AUTONOMY_CLASS: 'C' });
    assert.ok(override);
    assert.equal(override.class, 'C');
    assert.equal(override.taskClass, 'governance');
    assert.equal(override.profile.verification, 'strict');
    assert.equal(resolveAutonomyOverride({}), null);
    assert.throws(() => resolveAutonomyOverride({ BABEL_AUTONOMY_CLASS: 'x' }));
  });

  test('classifyAutonomyAction: read-only tools are Class A', () => {
    assert.equal(classifyAutonomyAction('file_read'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('directory_list'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('grep'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('glob'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('semantic_search'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('git_context'), 'a_autonomous');
  });

  test('classifyAutonomyAction: local mutate/verify tools are Class A', () => {
    assert.equal(classifyAutonomyAction('write_file'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('apply_patch'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('test_run'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('shell_exec', 'npm test'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('shell_exec', 'npx tsc --noEmit'), 'a_autonomous');
  });

  test('classifyAutonomyAction: engine shell surfaces (bash/shell) are Class A by tool name', () => {
    // chatEngine.ts:1105-1106 tool names — Class A by tool name, but command
    // patterns evaluated first when commandText present.
    assert.equal(classifyAutonomyAction('bash'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('shell'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('bash', 'npm test'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('bash', 'git status'), 'a_autonomous');
    assert.equal(classifyAutonomyAction('bash', 'git push --force origin main'), 'c_gated');
    assert.equal(classifyAutonomyAction('bash', 'cat .env'), 'd_forbidden');
  });

  test('classifyAutonomyAction: gated command markers are Class C', () => {
    assert.equal(classifyAutonomyAction('shell_exec', 'git push --force origin main'), 'c_gated');
    assert.equal(classifyAutonomyAction('shell_exec', 'git push -f'), 'c_gated');
    assert.equal(classifyAutonomyAction('shell_exec', 'git reset --hard HEAD~1'), 'c_gated');
    assert.equal(classifyAutonomyAction('shell_exec', 'git rebase main'), 'c_gated');
    assert.equal(classifyAutonomyAction('shell_exec', 'rm -rf artifacts/'), 'c_gated');
    assert.equal(classifyAutonomyAction('shell_exec', 'DROP TABLE users'), 'c_gated');
    assert.equal(classifyAutonomyAction('shell_exec', 'npm publish'), 'c_gated');
    assert.equal(classifyAutonomyAction('shell_exec', 'gh release create v1.0.0'), 'c_gated');
    assert.equal(classifyAutonomyAction('shell_exec', 'terraform destroy'), 'c_gated');
  });

  test('classifyAutonomyAction: credential exposure markers are Class D', () => {
    assert.equal(classifyAutonomyAction('shell_exec', 'cat .env'), 'd_forbidden');
    assert.equal(classifyAutonomyAction('file_read', '.env'), 'a_autonomous'); // tool path not command text
    assert.equal(
      classifyAutonomyAction('shell_exec', 'cat ~/.ssh/id_rsa'),
      'd_forbidden',
    );
    assert.equal(classifyAutonomyAction('shell_exec', 'echo $API_KEY'), 'd_forbidden');
    assert.equal(
      classifyAutonomyAction('shell_exec', 'printenv MY_SECRET_TOKEN'),
      'd_forbidden',
    );
  });

  test('classifyAutonomyAction: unknown tools fail closed to Class C', () => {
    assert.equal(classifyAutonomyAction('mcp_unknown_tool'), 'c_gated');
    assert.equal(classifyAutonomyAction(''), 'c_gated');
  });

  test('classifyAutonomyAction: subagent / parallel fan-out is Class B', () => {
    assert.equal(classifyAutonomyAction('sub_agent'), 'b_verified');
    assert.equal(classifyAutonomyAction('parallel'), 'b_verified');
  });

  test('resolveChatTaskClass honors BABEL_AUTONOMY_CLASS (env-gated)', () => {
    assert.equal(
      resolveChatTaskClass({ env: { BABEL_AUTONOMY_CLASS: 'A' }, autoClassify: false }),
      'default',
    );
    assert.equal(
      resolveChatTaskClass({ env: { BABEL_AUTONOMY_CLASS: 'B' }, autoClassify: false }),
      'general_swe',
    );
    assert.equal(
      resolveChatTaskClass({ env: { BABEL_AUTONOMY_CLASS: 'C' }, autoClassify: false }),
      'governance',
    );
    assert.equal(
      resolveChatTaskClass({ env: { BABEL_AUTONOMY_CLASS: 'D' }, autoClassify: false }),
      'governance',
    );
  });

  test('resolveChatTaskClass: explicit BABEL_CHAT_TASK_CLASS beats autonomy class', () => {
    const env = {
      BABEL_CHAT_TASK_CLASS: 'investigate',
      BABEL_AUTONOMY_CLASS: 'B',
    } as NodeJS.ProcessEnv;
    assert.equal(resolveChatTaskClass({ env, autoClassify: false }), 'investigate');
  });

  test('resolveChatTaskClass: invalid autonomy class fails closed (throws)', () => {
    const env = { BABEL_AUTONOMY_CLASS: 'nonsense' } as NodeJS.ProcessEnv;
    assert.throws(() =>
      resolveChatTaskClass({
        env,
        taskText: 'how many files are in src?',
        autoClassify: true,
      }),
    );
    // Unset env: unchanged default behavior
    assert.equal(resolveChatTaskClass({ env: {}, autoClassify: false }), 'default');
  });
});

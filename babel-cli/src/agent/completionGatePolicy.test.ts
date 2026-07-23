import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildGreenVerifierRejectionMessage,
  evaluateExecuteCompletionHonesty,
  hasGreenVerifierReceipt,
  isAgentOwnedAdHocVerifier,
  isAuthoritativeVerifierCommand,
  isLikelyVerifierCommand,
  requiresGreenVerifier,
  resolveVerificationPolicy,
  taskAsksForVerifier,
} from './completionGatePolicy.js';

describe('completionGatePolicy', () => {
  test('taskAsksForVerifier matches common wording', () => {
    assert.equal(taskAsksForVerifier('fix the bug and run npm test after making changes'), true);
    assert.equal(taskAsksForVerifier('just fix the typo'), false);
  });

  test('requiresGreenVerifier (legacy) from class or task', () => {
    assert.equal(
      requiresGreenVerifier({ requireGreenVerifierClass: true, task: 'fix x' }),
      true,
    );
    assert.equal(
      requiresGreenVerifier({
        requireGreenVerifierClass: false,
        task: 'fix and run tests before completing',
      }),
      true,
    );
    assert.equal(
      requiresGreenVerifier({ requireGreenVerifierClass: false, task: 'fix the typo' }),
      false,
    );
  });

  test('resolveVerificationPolicy escalates to strict when task asks', () => {
    assert.equal(
      resolveVerificationPolicy({ policy: 'required', task: 'fix and run tests before completing' }),
      'strict',
    );
    assert.equal(
      resolveVerificationPolicy({ policy: 'required', task: 'fix the typo' }),
      'required',
    );
    assert.equal(
      resolveVerificationPolicy({ policy: 'strict', task: 'fix the typo' }),
      'strict',
    );
    assert.equal(
      resolveVerificationPolicy({ policy: 'none', task: 'explain this code' }),
      'none',
    );
  });

  test('hasGreenVerifierReceipt only on exit 0', () => {
    assert.equal(hasGreenVerifierReceipt(null), false);
    assert.equal(
      hasGreenVerifierReceipt({ command: 'pytest', exit_code: 1, summary: '' }),
      false,
    );
    assert.equal(
      hasGreenVerifierReceipt({ command: 'pytest', exit_code: 0, summary: 'ok' }),
      true,
    );
  });

  test('honesty: no writes always reject', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: false,
      policy: 'strict',
      lastVerifierReceipt: { command: 't', exit_code: 0, summary: '' },
      toolCallLog: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'no_writes');
  });

  test('honesty: strict rejects missing and red verifier', () => {
    assert.equal(
      evaluateExecuteCompletionHonesty({
        hasWrite: true,
        policy: 'strict',
        lastVerifierReceipt: null,
        toolCallLog: [],
      }).reason,
      'verifier_missing',
    );
    assert.equal(
      evaluateExecuteCompletionHonesty({
        hasWrite: true,
        policy: 'strict',
        lastVerifierReceipt: { command: 'pytest', exit_code: 4, summary: '' },
        toolCallLog: [],
      }).reason,
      'verifier_red',
    );
  });

  test('honesty: strict green receipt allows', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: { command: 'pytest', exit_code: 0, summary: '15 passed' },
      toolCallLog: [],
    });
    assert.equal(r.allow, true);
  });

  test('honesty: none policy allows writes without verification', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'none',
      lastVerifierReceipt: null,
      toolCallLog: [],
    });
    assert.equal(r.allow, true);
  });

  test('honesty: required with missing verifier rejects', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'required',
      lastVerifierReceipt: null,
      toolCallLog: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'verifier_missing');
  });

  test('honesty: required with red verifier still allows (warns, user decides)', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'required',
      lastVerifierReceipt: { command: 'pytest', exit_code: 1, summary: '2 failed' },
      toolCallLog: [],
    });
    assert.equal(r.allow, true);
  });

  test('honesty: required with green receipt allows', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'required',
      lastVerifierReceipt: { command: 'pytest', exit_code: 0, summary: 'all pass' },
      toolCallLog: [],
    });
    assert.equal(r.allow, true);
  });

  test('rejection message mentions exit code when red', () => {
    const msg = buildGreenVerifierRejectionMessage('verifier_red', {
      command: 'pytest -q',
      exit_code: 1,
      summary: '',
    });
    assert.match(msg, /exit_code=1/);
    assert.match(msg, /pytest/);
  });

  test('rejection message includes project test commands when provided', () => {
    const msg = buildGreenVerifierRejectionMessage(
      'verifier_red',
      { command: 'del test.py', exit_code: 1, summary: '' },
      ['npm test', 'npx jest'],
    );
    assert.match(msg, /npm test, npx jest/);
  });
});

describe('isLikelyVerifierCommand', () => {
  test('recognizes common test runners', () => {
    assert.equal(isLikelyVerifierCommand('pytest'), true);
    assert.equal(isLikelyVerifierCommand('pytest tests/'), true);
    assert.equal(isLikelyVerifierCommand('npm test'), true);
    assert.equal(isLikelyVerifierCommand('npm run test -- --coverage'), true);
    assert.equal(isLikelyVerifierCommand('cargo test'), true);
    assert.equal(isLikelyVerifierCommand('go test ./...'), true);
    assert.equal(isLikelyVerifierCommand('make test'), true);
    assert.equal(isLikelyVerifierCommand('jest'), true);
    assert.equal(isLikelyVerifierCommand('mocha tests/'), true);
    assert.equal(isLikelyVerifierCommand('npx jest --coverage'), true);
    assert.equal(isLikelyVerifierCommand('deno test'), true);
    assert.equal(isLikelyVerifierCommand('bun test'), true);
    assert.equal(isLikelyVerifierCommand('ctest'), true);
    assert.equal(isLikelyVerifierCommand('dotnet test'), true);
    assert.equal(isLikelyVerifierCommand('rake test'), true);
    assert.equal(isLikelyVerifierCommand('rspec'), true);
    assert.equal(isLikelyVerifierCommand('pdm run test'), true);
    assert.equal(isLikelyVerifierCommand('poetry run pytest'), true);
    assert.equal(isLikelyVerifierCommand('tox'), true);
    assert.equal(isLikelyVerifierCommand('nox'), true);
  });

  test('recognises python variants', () => {
    assert.equal(isLikelyVerifierCommand('python -m pytest'), true);
    assert.equal(isLikelyVerifierCommand('python -m unittest discover'), true);
    assert.equal(isLikelyVerifierCommand('python -c "1+1"'), true);
    assert.equal(isLikelyVerifierCommand('python3 -c "import sys; print(1)"'), true);
    assert.equal(isLikelyVerifierCommand('python3 -m pytest tests/'), true);
  });

  test('recognises node -e as verifier (reproducer)', () => {
    assert.equal(isLikelyVerifierCommand('node -e "console.log(1)"'), true);
  });

  test('rejects shell utilities (B1 — must not become lastVerifierReceipt)', () => {
    // A03-class false_complete used this as the terminal "verifier"
    assert.equal(isLikelyVerifierCommand('del _verify_fix.py _test_qdp_fix.py'), false);
    assert.equal(isLikelyVerifierCommand('del _verify_fix.py'), false);
    assert.equal(isLikelyVerifierCommand('rm -rf temp'), false);
    assert.equal(isLikelyVerifierCommand('echo hello'), false);
    assert.equal(isLikelyVerifierCommand('ls'), false);
    assert.equal(isLikelyVerifierCommand('cat file.txt'), false);
    assert.equal(isLikelyVerifierCommand('type file.txt'), false);
    assert.equal(isLikelyVerifierCommand('dir'), false);
    assert.equal(isLikelyVerifierCommand('cd src'), false);
    assert.equal(isLikelyVerifierCommand('pwd'), false);
    assert.equal(isLikelyVerifierCommand('cp from to'), false);
    assert.equal(isLikelyVerifierCommand('mv from to'), false);
    assert.equal(isLikelyVerifierCommand('mkdir foo'), false);
    assert.equal(isLikelyVerifierCommand('rmdir foo'), false);
    assert.equal(isLikelyVerifierCommand('cls'), false);
    assert.equal(isLikelyVerifierCommand('clear'), false);
    assert.equal(isLikelyVerifierCommand('set FOO=bar'), false);
  });

  test('defaults to true for unknown commands', () => {
    assert.equal(isLikelyVerifierCommand('run_tests.sh'), true);
    assert.equal(isLikelyVerifierCommand('my_custom_test_runner'), true);
    assert.equal(isLikelyVerifierCommand('./scripts/verify.sh'), true);
  });

  test('empty or whitespace returns false', () => {
    assert.equal(isLikelyVerifierCommand(''), false);
    assert.equal(isLikelyVerifierCommand('   '), false);
  });

  test('null or undefined returns false', () => {
    assert.equal(isLikelyVerifierCommand(null), false);
    assert.equal(isLikelyVerifierCommand(undefined), false);
  });

  test('leading whitespace is trimmed before matching', () => {
    assert.equal(isLikelyVerifierCommand('  pytest'), true);
  });

  test('rejection message strikeCount=1 is standard', () => {
    const msg = buildGreenVerifierRejectionMessage(
      'verifier_red',
      { command: 'pytest', exit_code: 1, summary: '' },
      undefined,
      1,
    );
    assert.match(msg, /exit_code=1/);
    assert.match(msg, /pytest/);
    assert.doesNotMatch(msg, /rejection #1/);
    assert.match(msg, /You may not complete/);
  });

  test('rejection message strikeCount=2 adds escalation', () => {
    const msg = buildGreenVerifierRejectionMessage(
      'verifier_red',
      { command: 'del test.py', exit_code: 1, summary: '' },
      ['npm test'],
      2,
    );
    assert.match(msg, /rejection #2/);
    assert.match(msg, /were not valid test runs/);
    assert.match(msg, /Do NOT use shell utilities/);
    assert.match(msg, /_verify\*\.py/);
  });

  test('rejection message strikeCount=3 adds FINAL ATTEMPT', () => {
    const msg = buildGreenVerifierRejectionMessage(
      'verifier_missing',
      null,
      ['npm test'],
      3,
    );
    assert.match(msg, /rejection #3/);
    assert.match(msg, /FINAL ATTEMPT/);
    assert.match(msg, /Do NOT use shell utilities/);
    assert.match(msg, /_verify\*\.py/);
  });

  test('rejection message missing strikeCount (backward compat) still works', () => {
    const msg = buildGreenVerifierRejectionMessage(
      'verifier_red',
      { command: 'pytest', exit_code: 1, summary: '' },
      ['npm test', 'npx jest'],
    );
    assert.match(msg, /npm test, npx jest/);
    assert.doesNotMatch(msg, /rejection/);
  });
});

describe('gate command validation in evaluateExecuteCompletionHonesty', () => {
  test('bogus receipt command treated as verifier_missing', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: { command: 'del verifier.py', exit_code: 0, summary: '' },
      toolCallLog: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'verifier_missing');
  });

  test('bogus greenInLog entry does not satisfy verifier', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: null,
      toolCallLog: [
        { tool: 'run_command', target: 'echo pwd', detail: 'ok', exit_code: 0 },
      ],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'verifier_missing');
  });

  test('bogus receipt with real greenInLog still allows', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: { command: 'del verifier.py', exit_code: 0, summary: '' },
      toolCallLog: [
        { tool: 'run_command', target: 'pytest', detail: '15 passed', exit_code: 0 },
      ],
    });
    assert.equal(r.allow, true);
  });

  test('bogus receipt with bogus greenInLog rejects', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: { command: 'del verifier.py', exit_code: 0, summary: '' },
      toolCallLog: [
        { tool: 'run_command', target: 'echo hi', detail: 'ok', exit_code: 0 },
      ],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'verifier_missing');
  });

  test('real receipt with real greenInLog allows', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: { command: 'pytest tests/', exit_code: 0, summary: '15 passed' },
      toolCallLog: [
        { tool: 'test_run', target: 'npm test', detail: 'all pass', exit_code: 0 },
      ],
    });
    assert.equal(r.allow, true);
  });

  test('bogus receipt with non-zero exit still verifier_missing (not verifier_red)', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: { command: 'ls', exit_code: 1, summary: '' },
      toolCallLog: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'verifier_missing');
  });

  test('B2: agent-owned _verify*.py green receipt is verifier_missing', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: {
        command: 'python _verify_fix.py',
        exit_code: 0,
        summary: 'ok',
      },
      toolCallLog: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'verifier_missing');
  });

  test('B2: agent-owned _test_*.py green in log is not enough alone', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: null,
      toolCallLog: [
        {
          tool: 'run_command',
          target: 'python _test_qdp_fix.py',
          detail: 'ok',
          exit_code: 0,
        },
      ],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'verifier_missing');
  });

  test('B2: agent-owned green + authoritative green still allows', () => {
    const r = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: {
        command: 'python _verify_fix.py',
        exit_code: 0,
        summary: 'ok',
      },
      toolCallLog: [
        { tool: 'run_command', target: 'pytest tests/', detail: '15 passed', exit_code: 0 },
      ],
    });
    assert.equal(r.allow, true);
  });
});

describe('buildGateRejectUserMessageForEngine (P2.3 gate feedback)', () => {
  test('golden: verifier_missing message lists project tests and forbids ad-hoc scripts', async () => {
    const { buildGateRejectUserMessageForEngine } = await import('./completionGatePolicy.js');
    const msg = buildGateRejectUserMessageForEngine({
      task: 'fix the bug and run tests',
      taskClass: 'general_swe',
      toolCallLog: [
        { tool: 'write_file', target: 'src/foo.py', detail: 'ok', exit_code: 0 },
      ],
      lastVerifierReceipt: {
        command: 'python _verify_fix.py',
        exit_code: 0,
        summary: 'ok',
      },
      hasAnyWrites: true,
      projectTestCommands: ['pytest tests/test_foo.py -q'],
      gateStrikes: 1,
    });
    assert.match(msg, /verifier_missing|COMPLETION_GATE_REJECTED/i);
    assert.match(msg, /pytest tests\/test_foo\.py/);
    assert.match(msg, /_verify\*\.py/);
  });
});

describe('isAgentOwnedAdHocVerifier / isAuthoritativeVerifierCommand (B2)', () => {
  test('flags A03-class agent scripts', () => {
    assert.equal(isAgentOwnedAdHocVerifier('python _verify_fix.py'), true);
    assert.equal(isAgentOwnedAdHocVerifier('python3 ./_verify_fix.py'), true);
    assert.equal(isAgentOwnedAdHocVerifier('python _test_qdp_fix.py'), true);
    assert.equal(isAgentOwnedAdHocVerifier('py _check_foo.py'), true);
    assert.equal(isAgentOwnedAdHocVerifier('_verify_fix.py'), true);
    assert.equal(isAgentOwnedAdHocVerifier('node _verify_tmp.js'), true);
  });

  test('does not flag project/dataset runners', () => {
    assert.equal(isAgentOwnedAdHocVerifier('pytest'), false);
    assert.equal(isAgentOwnedAdHocVerifier('pytest tests/test_foo.py'), false);
    assert.equal(isAgentOwnedAdHocVerifier('python -m pytest'), false);
    assert.equal(isAgentOwnedAdHocVerifier('npm test'), false);
    assert.equal(isAgentOwnedAdHocVerifier('python tests/test_astropy.py'), false);
    // underscore inside path segment but not agent-owned prefix
    assert.equal(isAgentOwnedAdHocVerifier('pytest tests/test_verify_api.py'), false);
  });

  test('authoritative requires likely + not agent-owned', () => {
    assert.equal(isAuthoritativeVerifierCommand('pytest tests/'), true);
    assert.equal(isAuthoritativeVerifierCommand('npm test'), true);
    assert.equal(isAuthoritativeVerifierCommand('del _verify_fix.py'), false);
    assert.equal(isAuthoritativeVerifierCommand('python _verify_fix.py'), false);
    assert.equal(isAuthoritativeVerifierCommand('python _test_qdp_fix.py'), false);
    // still "likely" for logging, not authoritative for honesty
    assert.equal(isLikelyVerifierCommand('python _verify_fix.py'), true);
    assert.equal(isAuthoritativeVerifierCommand('python _verify_fix.py'), false);
  });
});

describe('planCompletionGateReject', () => {
  test('zero tools + no writes → auto_continue_block', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: false,
      policy: 'required',
      hardGate: true,
      hadToolCallsThisTurn: false,
      gateStrikes: 0,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'auto_continue_block');
  });

  test('strict policy blocks instead of infinite reject_continue after max strikes', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: true,
      policy: 'strict',
      hardGate: true,
      hadToolCallsThisTurn: true,
      gateStrikes: 10,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'blocked');
  });

  test('required + hardGate (headless/CI) hard-blocks after max strikes', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: true,
      policy: 'required',
      hardGate: true,
      hadToolCallsThisTurn: true,
      gateStrikes: 5,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'blocked');
    if (p.kind === 'blocked') {
      assert.match(p.reason, /Headless\/CI hard-block|Gate blocked/i);
    }
  });

  test('required + interactive soft-allows after max strikes', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: true,
      policy: 'required',
      hardGate: false,
      hadToolCallsThisTurn: true,
      gateStrikes: 5,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'soft_allow');
  });

  test('required + hardGate reject_continue before max strikes', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: true,
      policy: 'required',
      hardGate: true,
      hadToolCallsThisTurn: true,
      gateStrikes: 1,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'reject_continue');
  });

  test('strict policy auto-BLOCKED after max strikes to prevent budget spiral', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: true,
      policy: 'strict',
      hardGate: true,
      hadToolCallsThisTurn: true,
      gateStrikes: 3,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'blocked');
    if (p.kind === 'blocked') {
      assert.match(p.reason, /Gate blocked/);
      assert.match(p.reason, /verifier/i);
    }
  });

  test('strict policy continues before max strikes', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: true,
      policy: 'strict',
      hardGate: true,
      hadToolCallsThisTurn: true,
      gateStrikes: 1,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'reject_continue');
  });

  // Bug B: headless zero-write after max strikes → blocked (not soft_allow)
  test('hardGate zero-write after max strikes → blocked (not soft_allow)', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: false,
      policy: 'required',
      hardGate: true,
      hadToolCallsThisTurn: true,
      gateStrikes: 3,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'blocked');
    if (p.kind === 'blocked') {
      assert.match(p.reason, /no successful file mutations/);
      assert.match(p.reason, /Headless\/CI hard-block/);
    }
  });

  test('hardGate zero-write with tool calls but before max strikes → reject_continue', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: false,
      policy: 'required',
      hardGate: true,
      hadToolCallsThisTurn: true,
      gateStrikes: 1,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'reject_continue');
  });

  test('interactive zero-write after max strikes → soft_allow (preserved)', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: false,
      policy: 'required',
      hardGate: false,
      hadToolCallsThisTurn: true,
      gateStrikes: 5,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'soft_allow');
  });

  test('hardGate zero-write after max strikes + strict policy → blocked', async () => {
    const { planCompletionGateReject } = await import('./completionGatePolicy.js');
    const p = planCompletionGateReject({
      hasWrites: false,
      policy: 'strict',
      hardGate: true,
      hadToolCallsThisTurn: true,
      gateStrikes: 3,
      maxGateStrikes: 3,
    });
    assert.equal(p.kind, 'blocked');
    if (p.kind === 'blocked') {
      assert.match(p.reason, /no successful file mutations/);
    }
  });
});

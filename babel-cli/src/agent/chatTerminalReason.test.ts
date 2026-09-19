/**
 * D03 — structured terminal reason taxonomy.
 *
 * The reason code is the machine authority a UI may branch on; the free-text
 * `reason`/`message` remains diagnostic only. No prose-derived authority.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPolicySource,
  terminalReasonFromClassification,
  terminalReasonFromFailureText,
  terminalReasonFromOutcome,
  terminalReasonGuidance,
} from './chatTerminalReason.js';
import { classifyFailureText } from './chatFailureClassification.js';

describe('D03 classifyPolicySource', () => {
  test('progress_terminal after recovery is recovery_exhausted', () => {
    const reason = classifyPolicySource('progress_terminal', {
      noProgressReason: 'repeated_unchanged_reads',
    });
    assert.equal(reason?.code, 'recovery_exhausted');
    // Model kept re-reading unchanged bytes — a model-side cause.
    assert.equal(reason?.cause_class, 'model');
  });

  test('progress_terminal without a proven read cause stays harness/unknown-ish', () => {
    const reason = classifyPolicySource('progress_terminal');
    assert.equal(reason?.code, 'recovery_exhausted');
    assert.equal(reason?.cause_class, null);
  });

  test('explicit_deny is permission_denied (harness), never recovery', () => {
    const reason = classifyPolicySource('explicit_deny');
    assert.equal(reason?.code, 'permission_denied');
    assert.equal(reason?.cause_class, 'harness');
  });

  test('circuit_breaker maps to permission_denied per precedence table', () => {
    assert.equal(classifyPolicySource('circuit_breaker')?.code, 'permission_denied');
  });

  test('env_blocked / external_blocker are external_dependency (environment)', () => {
    assert.equal(classifyPolicySource('env_blocked')?.code, 'external_dependency');
    assert.equal(classifyPolicySource('env_blocked')?.cause_class, 'environment');
    assert.equal(classifyPolicySource('external_blocker')?.code, 'external_dependency');
  });

  test('hard ceiling and tool caps are budget_exhausted (harness)', () => {
    assert.equal(classifyPolicySource('hard_ceiling')?.code, 'budget_exhausted');
    assert.equal(classifyPolicySource('hard_ceiling')?.cause_class, 'harness');
    assert.equal(classifyPolicySource('investigate_hard_cap')?.code, 'budget_exhausted');
    assert.equal(classifyPolicySource('read_only_hard_cap')?.code, 'budget_exhausted');
  });

  test('zero_write hard stop is recovery_exhausted with an explicit detail', () => {
    const reason = classifyPolicySource('zero_write');
    assert.equal(reason?.code, 'recovery_exhausted');
    assert.equal(reason?.detail, 'zero_write_hard_stop');
  });

  test('nudge-only sources produce no terminal reason (no fabrication)', () => {
    for (const source of [
      'progress_nudge',
      'progress_recover',
      'force_mutate',
      'read_thrash',
      'exploration_fuse',
      'stall',
      'investigate_budget',
      'shell_soft_budget',
      null,
    ]) {
      assert.equal(classifyPolicySource(source), undefined, `source=${source}`);
    }
  });
});

describe('D03 terminalReasonFromFailureText', () => {
  test('provider transport failure is provider_failure/provider', () => {
    const reason = terminalReasonFromFailureText('[deepSeekApi] provider hard failure 500');
    assert.equal(reason?.code, 'provider_failure');
    assert.equal(reason?.cause_class, 'provider');
  });

  test('permission denied by policy is permission_denied/harness', () => {
    const reason = terminalReasonFromFailureText('permission denied by policy');
    assert.equal(reason?.code, 'permission_denied');
    assert.equal(reason?.cause_class, 'harness');
  });

  test('environment/toolchain text is external_dependency/environment', () => {
    const reason = terminalReasonFromFailureText('environment blocked: pytest missing');
    assert.equal(reason?.code, 'external_dependency');
    assert.equal(reason?.cause_class, 'environment');
  });

  test('budget text is budget_exhausted/harness', () => {
    const reason = terminalReasonFromFailureText('wall clock budget exceeded');
    assert.equal(reason?.code, 'budget_exhausted');
    assert.equal(reason?.cause_class, 'harness');
  });

  test('unclassifiable text yields no reason (unknown stays unknown)', () => {
    assert.equal(terminalReasonFromFailureText('synthetic stream crash'), undefined);
  });
});

describe('D03 terminalReasonFromOutcome', () => {
  test('maps canonical outcomes to sibling reason codes', () => {
    assert.equal(terminalReasonFromOutcome('CANCELLED')?.code, 'cancelled');
    assert.equal(terminalReasonFromOutcome('CANCELLED')?.cause_class, null);
    assert.equal(terminalReasonFromOutcome('BUDGET_EXHAUSTED')?.code, 'budget_exhausted');
    assert.equal(terminalReasonFromOutcome('BLOCKED_EXTERNAL')?.code, 'external_dependency');
    // BLOCKED_POLICY is broad; without an explicit source we must not assert a
    // permission cause.
    assert.equal(terminalReasonFromOutcome('BLOCKED_POLICY')?.code, 'unknown');
    assert.equal(terminalReasonFromOutcome('BLOCKED_POLICY')?.cause_class, null);
    assert.equal(terminalReasonFromOutcome('INFRA_FAILURE')?.code, 'provider_failure');
    assert.equal(terminalReasonFromOutcome('INFRA_FAILURE')?.cause_class, 'provider');
    assert.equal(terminalReasonFromOutcome('AGENT_FAILURE')?.code, 'unknown');
    assert.equal(terminalReasonFromOutcome('AGENT_FAILURE')?.cause_class, null);
    // Success-family outcomes carry no failure reason.
    assert.equal(terminalReasonFromOutcome('VERIFIED_COMPLETE'), undefined);
    assert.equal(terminalReasonFromOutcome('NO_CHANGE_REQUIRED'), undefined);
  });
});

describe('D03 terminalReasonFromClassification', () => {
  test('limiter classification maps to reason codes', () => {
    assert.equal(terminalReasonFromClassification('limit_wall')?.code, 'budget_exhausted');
    assert.equal(terminalReasonFromClassification('limit_tokens')?.code, 'budget_exhausted');
    assert.equal(terminalReasonFromClassification('limit_child')?.code, 'budget_exhausted');
    assert.equal(terminalReasonFromClassification('limit_stall')?.code, 'recovery_exhausted');
    assert.equal(terminalReasonFromClassification('model_failure')?.code, 'provider_failure');
    // `policy_block` is the broad bucket (zero_write / tamper / critic / gate /
    // stall / auto-continue). It must not fabricate a permission cause; only an
    // explicit source may claim permission_denied.
    assert.equal(terminalReasonFromClassification('policy_block')?.code, 'unknown');
    assert.equal(terminalReasonFromClassification('cancelled')?.code, 'cancelled');
    assert.equal(terminalReasonFromClassification('success'), undefined);
    assert.equal(terminalReasonFromClassification('no_limit_triggered'), undefined);
    assert.equal(terminalReasonFromClassification(null), undefined);
  });
});

describe('D03 terminalReasonGuidance', () => {
  test('recovery exhaustion tells the operator to inspect diagnostics / narrow scope', () => {
    const g = terminalReasonGuidance('recovery_exhausted');
    assert.match(g.message, /No progress after recovery/);
    assert.match(g.message, /inspect diagnostics/);
    assert.match(g.message, /narrow scope/);
    assert.ok(g.nextActions.includes('Inspect diagnostics'));
    assert.ok(g.nextActions.includes('Narrow scope'));
    // Never assert a missing capability/permission.
    assert.doesNotMatch(g.message, /permission/i);
    assert.doesNotMatch(g.nextActions.join(' '), /capability/i);
  });

  test('permission denial names the policy boundary', () => {
    const g = terminalReasonGuidance('permission_denied');
    assert.match(g.message, /not permitted/i);
    assert.ok(g.nextActions.some((a) => /permission/i.test(a)));
  });

  test('unknown guidance does not fabricate a cause', () => {
    const g = terminalReasonGuidance('unknown');
    assert.match(g.message, /not established/i);
  });

  test('guidance arrays are defensive copies', () => {
    const a = terminalReasonGuidance('provider_failure');
    a.nextActions.push('mutated');
    const b = terminalReasonGuidance('provider_failure');
    assert.deepEqual(b.nextActions, ['Retry']);
  });
});

describe('D03 origin attribution — local environment is not provider blame', () => {
  // Local OS resource errnos: disk full, read-only fs, io error, fd exhaustion.
  const LOCAL_ERRNOS = ['ENOSPC', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY'];
  for (const code of LOCAL_ERRNOS) {
    test(`${code} is a local environment failure, never provider_failure`, () => {
      const text = `write failed: ${code}: cannot write workspace`;
      const reason = terminalReasonFromFailureText(text);
      assert.notEqual(reason?.code, 'provider_failure', `${code} must not be blamed on the provider`);
      assert.equal(reason?.code, 'external_dependency');
      assert.equal(reason?.cause_class, 'environment');
      // The coarse outcome agrees with the typed reason (external, not infra).
      assert.equal(classifyFailureText(text), 'BLOCKED_EXTERNAL');
    });
  }

  const PROVIDER_TEXTS = [
    'provider stream error',
    'provider disconnected',
    'malformed SSE frame',
    'service unavailable',
    '502 Bad Gateway',
    '503 Service Unavailable',
    '504 Gateway Timeout',
    'provider startup idle',
    'connection reset by peer',
    'socket hang up',
    '[deepSeekApi] provider hard failure 500',
  ];
  for (const text of PROVIDER_TEXTS) {
    test(`real provider/network text stays provider_failure: ${text}`, () => {
      const reason = terminalReasonFromFailureText(text);
      assert.equal(reason?.code, 'provider_failure', text);
      assert.equal(reason?.cause_class, 'provider', text);
      assert.equal(classifyFailureText(text), 'INFRA_FAILURE', text);
    });
  }
});

describe('D03 generic policy text does not fabricate permission denial', () => {
  test('generic policy text is unknown; only explicit denial is permission_denied', () => {
    assert.equal(
      terminalReasonFromFailureText('blocked_policy: zero-write hard stop')?.code,
      'unknown',
    );
    assert.equal(
      terminalReasonFromFailureText('policy intervention: stall')?.code,
      'unknown',
    );
    assert.equal(
      terminalReasonFromFailureText('permission denied by policy')?.code,
      'permission_denied',
    );
  });
});

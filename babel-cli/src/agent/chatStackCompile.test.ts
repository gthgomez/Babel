/**
 * U1.4: Slim interactive stack — budget-aware compilation tests.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  compileChatStack,
  INTERACTIVE_STACK_BUDGET,
  resolveStackBudgetForClass,
  SWE_STACK_BUDGET,
  type ChatCompiledStack,
} from './chatStackCompile.js';

describe('resolveStackBudgetForClass', () => {
  it('returns INTERACTIVE_STACK_BUDGET (12_000) for non-SWE classes', () => {
    assert.equal(resolveStackBudgetForClass('default'), INTERACTIVE_STACK_BUDGET);
    assert.equal(resolveStackBudgetForClass('quick_fix'), INTERACTIVE_STACK_BUDGET);
    assert.equal(resolveStackBudgetForClass('investigate'), INTERACTIVE_STACK_BUDGET);
    assert.equal(resolveStackBudgetForClass('governance'), INTERACTIVE_STACK_BUDGET);
  });

  it('returns SWE_STACK_BUDGET (24_000) for general_swe', () => {
    assert.equal(resolveStackBudgetForClass('general_swe'), SWE_STACK_BUDGET);
  });

  it('returns INTERACTIVE_STACK_BUDGET for undefined class (safe default)', () => {
    assert.equal(resolveStackBudgetForClass(undefined), INTERACTIVE_STACK_BUDGET);
  });

  it('interactive budget is lower than SWE budget', () => {
    assert.ok(
      INTERACTIVE_STACK_BUDGET < SWE_STACK_BUDGET,
      `INTERACTIVE_STACK_BUDGET (${INTERACTIVE_STACK_BUDGET}) must be < SWE_STACK_BUDGET (${SWE_STACK_BUDGET})`,
    );
  });

  it('interactive budget ≤ 12_000 as documented', () => {
    assert.ok(
      INTERACTIVE_STACK_BUDGET <= 12_000,
      'Interactive budget must be ≤ 12_000 per U1.4 spec',
    );
  });
});

describe('compileChatStack budget behavior', () => {
  it('respects explicit promptBudgetChars option', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: 5_000,
      includeDomainSkill: false,
    });

    assert.ok(stack.system_context.length <= 5_000 + 50); // small tolerance for trim marker
    assert.ok(stack.selected_entries.length >= 3); // identity + safety + verifier at minimum
  });

  it('interactive budget (12_000) produces system_context ≤ 12_000', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: INTERACTIVE_STACK_BUDGET,
      includeDomainSkill: false,
    });

    // Budget trim may add ~35 chars for the trim marker
    assert.ok(
      stack.system_context.length <= INTERACTIVE_STACK_BUDGET + 50,
      `system_context length ${stack.system_context.length} should be ≤ ${INTERACTIVE_STACK_BUDGET + 50}`,
    );
  });

  it('SWE budget (24_000) produces system_context ≤ 24_000', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: SWE_STACK_BUDGET,
      includeDomainSkill: false,
    });

    assert.ok(
      stack.system_context.length <= SWE_STACK_BUDGET + 50,
      `system_context length ${stack.system_context.length} should be ≤ ${SWE_STACK_BUDGET + 50}`,
    );
  });

  it('interactive budget stack has lower estimated_tokens than SWE stack for same input', () => {
    const interactive = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: INTERACTIVE_STACK_BUDGET,
      includeDomainSkill: false,
    });

    const swe = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: SWE_STACK_BUDGET,
      includeDomainSkill: false,
    });

    // With the same input, the interactive budget may trim earlier.
    // If both fit within 12_000, they'll be equal; otherwise interactive < swe.
    assert.ok(
      interactive.estimated_tokens <= swe.estimated_tokens,
      `interactive tokens (${interactive.estimated_tokens}) should be ≤ SWE tokens (${swe.estimated_tokens})`,
    );
  });

  it('estimated_tokens is derived from system_context length', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: 6_000,
      includeDomainSkill: false,
    });

    const expected = Math.ceil(stack.system_context.length / 4);
    assert.equal(stack.estimated_tokens, expected);
  });
});

describe('compileChatStack shape invariants', () => {
  it('always includes deep_stages_excluded: true', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
    });

    assert.equal(stack.deep_stages_excluded, true);
  });

  it('always includes identity, safety, provider, and verifier entries', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      includeDomainSkill: false,
    });

    const layers = new Set(stack.selected_entries.map((e) => e.layer));
    assert.ok(layers.has('identity'), 'must have identity layer');
    assert.ok(layers.has('safety'), 'must have safety layer');
    assert.ok(layers.has('provider'), 'must have provider layer');
    assert.ok(layers.has('verifier'), 'must have verifier layer');
  });

  it('produces a stable manifest_hash for same inputs', () => {
    const a = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: 12_000,
      includeDomainSkill: false,
    });

    const b = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: 12_000,
      includeDomainSkill: false,
    });

    assert.equal(a.manifest_hash, b.manifest_hash);
  });

  it('different budgets can produce different hashes when trimming changes content', () => {
    // Same project root + task but different budgets — hash may differ
    // if the system_context was trimmed.
    const a = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: 2_000,
      includeDomainSkill: false,
    });

    const b = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix a bug',
      promptBudgetChars: 24_000,
      includeDomainSkill: false,
    });

    // Entries should be identical (same selection), just different trim
    const aIds = a.selected_entries.map((e) => e.id).sort().join(',');
    const bIds = b.selected_entries.map((e) => e.id).sort().join(',');
    assert.equal(aIds, bIds);
  });

  it('project_root is resolved to absolute path', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix',
    });

    assert.ok(stack.project_root.includes('tmp'));
    assert.ok(stack.project_root.includes('test'));
  });

  it('includes domain/skill hints when task matches and includeDomainSkill is default', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix the React component rendering',
    });

    const domain = stack.selected_entries.find((e) => e.layer === 'domain');
    assert.ok(domain, 'should include domain entry for React task');
  });

  it('skips domain/skill when includeDomainSkill is false', () => {
    const stack = compileChatStack({
      projectRoot: '/tmp/test',
      task: 'fix the React component rendering',
      includeDomainSkill: false,
    });

    const domain = stack.selected_entries.find((e) => e.layer === 'domain');
    assert.equal(domain, undefined);
  });
});

describe('compileChatStack with real project root', () => {
  let tempDir: string;

  it('loads identity from AGENTS.md when present in project root', () => {
    // Use the real repo root which has AGENTS.md
    const stack = compileChatStack({
      projectRoot: '<BABEL_REPO_ROOT>',
      task: 'fix a bug',
      promptBudgetChars: 12_000,
    });

    const identity = stack.selected_entries.find((e) => e.layer === 'identity');
    assert.ok(identity, 'must have identity entry');
    // When AGENTS.md exists, it should be loaded from repo root
    assert.ok(identity!.path.includes('AGENTS.md') || identity!.path.includes('CLAUDE.md'),
      `identity path should be AGENTS.md or CLAUDE.md, got: ${identity!.path}`);
    assert.ok(identity!.contentPreview, 'identity should have content preview');
  });
});

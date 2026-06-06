import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentAction } from './actions.js';
import {
  decideAction,
  mergeDecisions,
  presetForVerb,
} from './policy.js';

describe('decideAction', () => {
  const writeFile: AgentAction = { type: 'write_file', path: 'src/a.ts', content: 'x' };
  const applyPatch: AgentAction = { type: 'apply_patch', patch: 'diff' };
  const runCommand: AgentAction = { type: 'run_command', command: 'npm test' };
  const readFile: AgentAction = { type: 'read_file', path: 'src/a.ts' };

  it('denies mutating actions under read_only preset', () => {
    assert.equal(decideAction(writeFile, 'read_only'), 'deny');
    assert.equal(decideAction(applyPatch, 'read_only'), 'deny');
    assert.equal(decideAction(runCommand, 'read_only'), 'deny');
    assert.equal(decideAction(readFile, 'read_only'), 'allow');
  });

  it('asks before mutation under ask_before_mutation preset', () => {
    assert.equal(decideAction(writeFile, 'ask_before_mutation'), 'ask');
    assert.equal(decideAction(runCommand, 'ask_before_mutation'), 'ask');
    assert.equal(decideAction(readFile, 'ask_before_mutation'), 'allow');
  });

  it('allows fix-verb mutations under workspace_write preset', () => {
    assert.equal(decideAction(writeFile, 'workspace_write'), 'allow');
    assert.equal(decideAction(runCommand, 'workspace_write'), 'allow');
  });

  it('denies risky network/install commands unless auto_safe asks', () => {
    const curl: AgentAction = { type: 'run_command', command: 'curl https://example.com' };
    const install: AgentAction = { type: 'run_command', command: 'npm install left-pad' };

    assert.equal(decideAction(curl, 'workspace_write'), 'deny');
    assert.equal(decideAction(install, 'workspace_write'), 'deny');
    assert.equal(decideAction(curl, 'auto_safe'), 'ask');
    assert.equal(decideAction(install, 'auto_safe'), 'ask');
  });
});

describe('mergeDecisions', () => {
  it('deny overrides allow and ask', () => {
    assert.equal(mergeDecisions('allow', 'ask', 'deny'), 'deny');
    assert.equal(mergeDecisions('allow', 'ask'), 'ask');
    assert.equal(mergeDecisions('allow', 'allow'), 'allow');
  });
});

describe('presetForVerb', () => {
  it('uses workspace_write for fix verb', () => {
    assert.equal(presetForVerb('fix'), 'workspace_write');
  });

  it('uses read_only for plan and propose verbs', () => {
    assert.equal(presetForVerb('plan'), 'read_only');
    assert.equal(presetForVerb('propose'), 'read_only');
  });
});

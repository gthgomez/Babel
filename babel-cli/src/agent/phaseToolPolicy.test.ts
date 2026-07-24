import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePhaseToolGate, isPhaseGatedToolsEnabled } from './phaseToolPolicy.js';

describe('phaseToolPolicy', () => {
  const prev = process.env['BABEL_PHASE_GATED_TOOLS'];
  const prevClass = process.env['BABEL_CHAT_TASK_CLASS'];
  const prevSwe = process.env['BABEL_CHAT_SWE_PROFILE'];

  beforeEach(() => {
    delete process.env['BABEL_PHASE_GATED_TOOLS'];
    delete process.env['BABEL_CHAT_TASK_CLASS'];
    delete process.env['BABEL_CHAT_SWE_PROFILE'];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env['BABEL_PHASE_GATED_TOOLS'];
    else process.env['BABEL_PHASE_GATED_TOOLS'] = prev;
    if (prevClass === undefined) delete process.env['BABEL_CHAT_TASK_CLASS'];
    else process.env['BABEL_CHAT_TASK_CLASS'] = prevClass;
    if (prevSwe === undefined) delete process.env['BABEL_CHAT_SWE_PROFILE'];
    else process.env['BABEL_CHAT_SWE_PROFILE'] = prevSwe;
  });

  it('is off by default for default task class', () => {
    delete process.env['BABEL_CHAT_TASK_CLASS'];
    delete process.env['BABEL_CHAT_SWE_PROFILE'];
    assert.equal(isPhaseGatedToolsEnabled(), false);
  });

  it('task-class defaults: general_swe off, governance/investigate on when env unset', () => {
    // Soft-nudge policy: general_swe does not phase-gate tools by default.
    process.env['BABEL_CHAT_TASK_CLASS'] = 'general_swe';
    assert.equal(isPhaseGatedToolsEnabled(), false);
    process.env['BABEL_CHAT_TASK_CLASS'] = 'governance';
    assert.equal(isPhaseGatedToolsEnabled(), true);
    process.env['BABEL_CHAT_TASK_CLASS'] = 'investigate';
    assert.equal(isPhaseGatedToolsEnabled(), true);
  });

  it('explicit BABEL_PHASE_GATED_TOOLS=0 opts out even on general_swe', () => {
    process.env['BABEL_CHAT_TASK_CLASS'] = 'general_swe';
    process.env['BABEL_PHASE_GATED_TOOLS'] = '0';
    assert.equal(isPhaseGatedToolsEnabled(), false);
  });

  it('does not block when disabled', () => {
    const r = evaluatePhaseToolGate({
      toolName: 'str_replace',
      phase: 'investigate',
      enabled: false,
    });
    assert.equal(r.blocked, false);
  });

  it('blocks writes in investigate when enabled', () => {
    const r = evaluatePhaseToolGate({
      toolName: 'write_file',
      phase: 'investigate',
      enabled: true,
    });
    assert.equal(r.blocked, true);
  });

  it('blocks search in verify when enabled', () => {
    const r = evaluatePhaseToolGate({
      toolName: 'grep',
      phase: 'verify',
      enabled: true,
    });
    assert.equal(r.blocked, true);
  });

  it('allows run_command in verify', () => {
    const r = evaluatePhaseToolGate({
      toolName: 'run_command',
      phase: 'verify',
      enabled: true,
    });
    assert.equal(r.blocked, false);
  });
});

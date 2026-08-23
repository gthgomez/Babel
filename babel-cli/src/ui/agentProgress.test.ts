/**
 * does X when Y tests for agent identity vs status tones.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_IDENTITY_STYLERS,
  AgentStreamManager,
} from './agentProgress.js';
import { error, success, warning } from './theme.js';

describe('agent identity palette', () => {
  it('does not use success warning or error as identity tones', () => {
    for (const styler of AGENT_IDENTITY_STYLERS) {
      assert.notEqual(styler, success);
      assert.notEqual(styler, warning);
      assert.notEqual(styler, error);
    }
  });

  it('does keep status glyphs independent of identity prefix', () => {
    const mgr = new AgentStreamManager();
    mgr.registerAgent('A1');
    mgr.registerAgent('A2');
    mgr.registerAgent('A3');
    mgr.registerAgent('A4');
    mgr.registerAgent('A5');

    const complete = mgr.formatEvent({
      agentId: 'A4',
      type: 'tool_complete',
      tool: 'grep',
      detail: 'ok',
    });
    const failed = mgr.formatEvent({
      agentId: 'A5',
      type: 'error',
      text: 'boom',
    });

    assert.match(complete, /\[A4\]/);
    assert.match(complete, /✓/);
    assert.match(failed, /\[A5\]/);
    assert.match(failed, /boom/);
  });
});

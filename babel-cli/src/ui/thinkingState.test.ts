import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeThinkingHud, leaveThinking } from './thinkingState.js';
import { containsDestructiveCursorRewrite } from './cursorRewritePolicy.js';

describe('thinking HUD ConPTY safety', () => {
  it('collapses multi-line overlays to one line without CUU/ED when append-only', () => {
    const prev = process.env['BABEL_ANSWER_REWRITE'];
    process.env['BABEL_ANSWER_REWRITE'] = 'append-only';
    try {
      const hud = composeThinkingHud({
        indicatorLine: '  thinking  00:02',
        overlayLines: ['Indexing workspace...', 'scan 12/40'],
        columns: 80,
        previousOverlayLines: 0,
      });
      assert.equal(hud.showingOverlayLines, 0);
      assert.equal(containsDestructiveCursorRewrite(hud.output), false);
      assert.match(hud.output, /thinking/);
      assert.match(hud.output, /Indexing workspace/);
      assert.equal(hud.output.includes('\n'), false);
    } finally {
      if (prev === undefined) delete process.env['BABEL_ANSWER_REWRITE'];
      else process.env['BABEL_ANSWER_REWRITE'] = prev;
    }
  });

  it('leaveThinking does not emit CUU on append-only hosts', () => {
    const prev = process.env['BABEL_ANSWER_REWRITE'];
    process.env['BABEL_ANSWER_REWRITE'] = 'append-only';
    const writes: string[] = [];
    try {
      leaveThinking({
        state: 'thinking',
        reason: 'stream',
        isTTY: true,
        overlayLines: 4,
        write: (text) => {
          writes.push(text);
          return true;
        },
        transition: () => undefined,
        unregisterTick: () => undefined,
      });
      const out = writes.join('');
      assert.equal(containsDestructiveCursorRewrite(out), false);
      assert.match(out, /\r\x1b\[K/);
    } finally {
      if (prev === undefined) delete process.env['BABEL_ANSWER_REWRITE'];
      else process.env['BABEL_ANSWER_REWRITE'] = prev;
    }
  });

  it('capable terminals may still cursor-up a multi-line overlay', () => {
    const prev = process.env['BABEL_ANSWER_REWRITE'];
    process.env['BABEL_ANSWER_REWRITE'] = 'csi';
    try {
      const hud = composeThinkingHud({
        indicatorLine: '  thinking',
        overlayLines: ['Indexing workspace...'],
        columns: 80,
        previousOverlayLines: 0,
      });
      assert.equal(hud.showingOverlayLines, 1);
      assert.match(hud.output, /\x1b\[1A/);
    } finally {
      if (prev === undefined) delete process.env['BABEL_ANSWER_REWRITE'];
      else process.env['BABEL_ANSWER_REWRITE'] = prev;
    }
  });
});

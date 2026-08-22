import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canUseCursorRewrite,
  containsDestructiveCursorRewrite,
} from './cursorRewritePolicy.js';

describe('cursorRewritePolicy', () => {
  it('BABEL_ANSWER_REWRITE=append-only forbids CUU/ED even on capable hosts', () => {
    const prev = process.env['BABEL_ANSWER_REWRITE'];
    process.env['BABEL_ANSWER_REWRITE'] = 'append-only';
    try {
      assert.equal(canUseCursorRewrite(), false);
    } finally {
      if (prev === undefined) delete process.env['BABEL_ANSWER_REWRITE'];
      else process.env['BABEL_ANSWER_REWRITE'] = prev;
    }
  });

  it('BABEL_ANSWER_REWRITE=csi allows CUU/ED', () => {
    const prev = process.env['BABEL_ANSWER_REWRITE'];
    process.env['BABEL_ANSWER_REWRITE'] = 'csi';
    try {
      assert.equal(canUseCursorRewrite(), true);
    } finally {
      if (prev === undefined) delete process.env['BABEL_ANSWER_REWRITE'];
      else process.env['BABEL_ANSWER_REWRITE'] = prev;
    }
  });

  it('detects CUU and ED but not EL or SGR', () => {
    assert.equal(containsDestructiveCursorRewrite('\x1b[3A'), true);
    assert.equal(containsDestructiveCursorRewrite('\x1b[A'), true);
    assert.equal(containsDestructiveCursorRewrite('\x1b[J'), true);
    assert.equal(containsDestructiveCursorRewrite('\x1b[2J'), true);
    assert.equal(containsDestructiveCursorRewrite('\r\x1b[Khello'), false);
    assert.equal(containsDestructiveCursorRewrite('\x1b[36mcyan\x1b[0m'), false);
  });
});

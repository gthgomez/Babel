import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitA11yEvent,
  a11yStageEvent,
  a11yActivityEvent,
  a11yToolEvent,
  isA11yMode,
} from './a11y.js';
import type { A11yStructuredEvent } from './a11y.js';

// Helper to capture stdout
function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    const str = String(chunk);
    if (str.startsWith('A11Y:')) lines.push(str);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return lines;
}

describe('a11y structured events', () => {
  const origA11y = process.env['BABEL_A11Y'];

  before(() => {
    process.env['BABEL_A11Y'] = '1';
  });
  after(() => {
    if (origA11y !== undefined) process.env['BABEL_A11Y'] = origA11y;
    else delete process.env['BABEL_A11Y'];
  });

  it('emitA11yEvent outputs A11Y: prefixed JSON line', () => {
    const lines = captureStdout(() => {
      emitA11yEvent({
        ts: '2026-06-24T00:00:00.000Z',
        type: 'stage',
        stage_index: 1,
        message: 'Planning',
      });
    });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!.slice(5)); // strip "A11Y:" prefix
    assert.equal(parsed.type, 'stage');
    assert.equal(parsed.stage_index, 1);
    assert.equal(parsed.message, 'Planning');
  });

  it('a11yStageEvent emits structured stage event', () => {
    const lines = captureStdout(() => {
      a11yStageEvent(2, 'Reviewing');
    });
    assert.equal(lines.length, 1);
    const parsed: A11yStructuredEvent = JSON.parse(lines[0]!.slice(5));
    assert.equal(parsed.type, 'stage');
    assert.equal(parsed.stage_index, 2);
    assert.equal(parsed.message, 'Reviewing');
    assert.ok(parsed.ts, 'has timestamp');
  });

  it('a11yActivityEvent emits structured activity event', () => {
    const lines = captureStdout(() => {
      a11yActivityEvent('Reading file: src/index.ts');
    });
    assert.equal(lines.length, 1);
    const parsed: A11yStructuredEvent = JSON.parse(lines[0]!.slice(5));
    assert.equal(parsed.type, 'activity');
    assert.ok(parsed.message!.includes('Reading file'));
  });

  it('a11yToolEvent emits structured tool event', () => {
    const lines = captureStdout(() => {
      a11yToolEvent('file_read', 'src/index.ts');
    });
    assert.equal(lines.length, 1);
    const parsed: A11yStructuredEvent = JSON.parse(lines[0]!.slice(5));
    assert.equal(parsed.type, 'tool_call');
    assert.equal(parsed.tool, 'file_read');
    assert.equal(parsed.message, 'file_read src/index.ts');
  });

  it('emitA11yEvent is silent when BABEL_A11Y is not set', () => {
    const savedNoColor = process.env['NO_COLOR'];
    delete process.env['BABEL_A11Y'];
    delete process.env['NO_COLOR'];
    try {
      const lines = captureStdout(() => {
        emitA11yEvent({
          ts: new Date().toISOString(),
          type: 'activity',
          message: 'should not appear',
        });
      });
      assert.equal(lines.length, 0);
    } finally {
      process.env['BABEL_A11Y'] = '1';
      if (savedNoColor === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = savedNoColor;
    }
  });
});

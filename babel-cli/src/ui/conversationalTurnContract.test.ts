/**
 * Byte-level conversational TUI ordering contract.
 *
 * ASSISTANT  <  TURN_METADATA  <  REVIEW_CARD
 * No CUU/ED on the default ConPTY path.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ConversationalRenderer } from './waterfall.js';
import { stripAnsi } from './theme.js';
import { containsDestructiveCursorRewrite } from './cursorRewritePolicy.js';
import { resetTerminalProbe } from './terminalProbe.js';
import { OutputBuffer } from './outputBuffer.js';
import { backgroundTaskRegistry } from '../services/backgroundTaskRegistry.js';
import { renderProjectedReviewCard, projectTurnViewState } from '../interactive/projection/turnViewProjector.js';

function interceptStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stdout.write;
  const savedNoColor = process.env['NO_COLOR'];
  const savedA11y = process.env['BABEL_A11Y'];
  delete process.env['NO_COLOR'];
  delete process.env['BABEL_A11Y'];
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    writes,
    restore: () => {
      process.stdout.write = orig;
      if (savedNoColor === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = savedNoColor;
      if (savedA11y === undefined) delete process.env['BABEL_A11Y'];
      else process.env['BABEL_A11Y'] = savedA11y;
    },
  };
}

function setEnv(overrides: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTerminalProbe();
  OutputBuffer.resetInstance();
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetTerminalProbe();
    OutputBuffer.resetInstance();
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('conversational turn physical ordering (ConPTY fallback)', () => {
  let restoreEnv: () => void;

  before(() => {
    restoreEnv = setEnv({
      BABEL_ANSWER_REWRITE: 'append-only',
      BABEL_SCROLL_REGIONS: '0',
      NO_COLOR: undefined,
      BABEL_A11Y: undefined,
    });
  });

  after(() => {
    restoreEnv();
  });

  it('flushes coalesced assistant tail before turn metadata', async () => {
    const { writes, restore } = interceptStdout();
    const r = new ConversationalRenderer({ isTTY: true });
    try {
      r.start();
      r.onAnswerChunk("I'm ready to help. What would you like me to work on?\n\n");
      r.onAnswerChunk('UNIQUE_TAIL_FRAGMENT');
      r.onSummary({ perRunCost: 0.001, costUSD: 0.001 });
      r.stop();
    } finally {
      restore();
    }

    const raw = writes.join('');
    const text = stripAnsi(raw);
    const tailIdx = text.indexOf('UNIQUE_TAIL_FRAGMENT');
    assert.ok(tailIdx >= 0, `missing assistant tail: ${text}`);
    const metaIdx = text.lastIndexOf('·');
    assert.ok(metaIdx > tailIdx, `metadata must follow assistant, got:\n${text}`);
    assert.equal(
      text.indexOf('UNIQUE_TAIL_FRAGMENT', metaIdx),
      -1,
      'NO_ASSISTANT_BYTES_AFTER_TURN_METADATA',
    );
    assert.doesNotMatch(text, /\$0\.001/, 'turn cost must not repeat on the elapsed line');
    assert.equal(
      containsDestructiveCursorRewrite(raw),
      false,
      'NO_UNSAFE_CUU_ED_ON_DEFAULT_CONPTY_PATH',
    );
  });

  it('does not project a duplicated conversational Summary', () => {
    const view = projectTurnViewState([
      {
        type: 'turn_started',
        turnId: 't1',
        timestamp: 1,
        userInput: '?',
        taskClass: 'default',
        model: 'DeepSeek V4 Flash',
        modelId: 'deepseek-v4-flash',
      },
      {
        type: 'assistant_chunk_received',
        timestamp: 2,
        textChunk: "I'm ready to help. What would you like me to work on?",
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 3,
        outcome: 'NO_CHANGE_REQUIRED',
        status: 'completed',
        finalAnswer: "I'm ready to help. What would you like me to work on?",
      },
    ]);
    const card = renderProjectedReviewCard(view, {
      verificationApplicability: 'not_applicable',
      costUsd: 0.001,
      tokens: 50,
    });
    const text = stripAnsi(card.body);
    assert.doesNotMatch(text, /^Summary$/m);
    assert.doesNotMatch(text, /I'm ready to help/);
    assert.match(text, /\$0\.0010 this turn/);
  });

  it('collapses indexing overlay without accumulating blank rows, then streams the answer', async () => {
    const taskId = backgroundTaskRegistry.register('Indexing workspace');
    const { writes, restore } = interceptStdout();
    const r = new ConversationalRenderer({ isTTY: true });
    try {
      r.start();
      await delay(450);
      r.onAnswerChunk('Hello from the overlay path.\n');
      r.onSummary();
      r.stop();
    } finally {
      restore();
      backgroundTaskRegistry.complete(taskId);
    }
    const raw = writes.join('');
    const text = stripAnsi(raw);
    assert.equal(containsDestructiveCursorRewrite(raw), false);
    assert.match(text, /Hello from the overlay path/);
    const helloIdx = text.indexOf('Hello from the overlay path');
    assert.doesNotMatch(text.slice(helloIdx), /\n{6,}/);
  });

  it('seals generation A before generation B', async () => {
    const r = new ConversationalRenderer({ isTTY: true });
    const { restore } = interceptStdout();
    try {
      r.start();
      r.onAnswerChunk('Generation A answer.\n');
      await delay(40);
      r.onAnswerGenerationBoundary();
      r.onAnswerChunk('Generation B answer.\n');
      await delay(40);
      r.onSummary();
      r.stop();
      const cells = r.getHistoryCellRecords();
      const assistants = cells.filter((c) => c.kind === 'assistant_message');
      assert.ok(assistants.length >= 2, `expected separate generation cells, got ${assistants.length}`);
    } finally {
      restore();
    }
  });

  it('seals the streamed answer at a tool boundary', async () => {
    const r = new ConversationalRenderer({ isTTY: true });
    const { restore } = interceptStdout();
    try {
      r.start();
      r.onAnswerChunk('I will inspect the file.\n');
      await delay(40);
      const id = r.onToolCallStart('read_file', 'src/a.ts');
      r.onToolCallComplete(id, 'ok');
      r.onAnswerChunk('Inspection complete.\n');
      await delay(40);
      r.onSummary();
      r.stop();
      const cells = r.getHistoryCellRecords();
      assert.ok(cells.some((c) => c.kind === 'assistant_message'));
      assert.ok(cells.some((c) => c.kind === 'tool_call'));
    } finally {
      restore();
    }
  });

  it('fallback resize does not emit CUU/ED', async () => {
    const { writes, restore } = interceptStdout();
    const r = new ConversationalRenderer({ isTTY: true });
    const prevRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    const prevCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    try {
      Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
      r.start();
      r.onAnswerChunk('Resize-safe paragraph one.\n\nResize-safe paragraph two.\n');
      await delay(40);
      Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true });
      process.stdout.emit('resize');
      await delay(150);
      r.onSummary();
      r.stop();
    } finally {
      restore();
      if (prevRows) Object.defineProperty(process.stdout, 'rows', prevRows);
      if (prevCols) Object.defineProperty(process.stdout, 'columns', prevCols);
    }
    const raw = writes.join('');
    assert.equal(containsDestructiveCursorRewrite(raw), false);
  });
});

describe('capable-terminal rewrite policy remains available', () => {
  it('CSI override may emit cursor-up on markdown rewrite', async () => {
    const restoreEnv = setEnv({
      BABEL_ANSWER_REWRITE: 'csi',
      BABEL_SCROLL_REGIONS: '0',
    });
    const { writes, restore } = interceptStdout();
    const r = new ConversationalRenderer({ isTTY: true });
    try {
      r.start();
      r.onAnswerChunk('## Title');
      r.onAnswerChunk('\n\n');
      r.onAnswerChunk('body\n');
      await delay(40);
      r.onSummary();
      r.stop();
    } finally {
      restore();
      restoreEnv();
    }
    const raw = writes.join('');
    assert.match(stripAnsi(raw), /body/);
  });
});

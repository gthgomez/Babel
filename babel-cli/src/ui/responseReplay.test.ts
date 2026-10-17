import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationalRenderer } from './conversationalRenderer.js';
import { createVirtualCellGrid } from './observe/virtualCellGrid.js';
import { OutputBuffer } from './outputBuffer.js';
import { resetTerminalProbe } from './terminalProbe.js';
import { TwoRegionStreaming } from './twoRegionStreaming.js';
import { renderMarkdown } from './highlight.js';
import { createTuiStore } from './stateMutationBus.js';
import { suspendActiveRendererForExclusiveSurface } from './rendererFence.js';

const response = '# Synthetic reply\n\n1. **Unique first**: preserve this sentence through wrapping and finalization.\n2. **Unique second**: preserve order and inline `code`.\n\nUnique final sentence.';

test('an empty successful response does not publish a failed state', () => {
  const store = createTuiStore();
  const transitions: string[] = [];
  store.subscribe('state:transition', (mutation) => {
    if (mutation.type === 'state:transition') transitions.push(mutation.to);
  });
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof write;
  const renderer = new ConversationalRenderer({ isTTY: true, ownsInput: false, stateStore: store });
  try {
    renderer.start(); renderer.onSummary(); renderer.stop();
    assert.equal(transitions.includes('failed'), false);
    assert.equal(transitions.at(-1), 'done');
  } finally { renderer.stop(); process.stdout.write = write; }
});

for (const hardware of ['0', '1']) {
  for (const ending of ['complete', 'cancel', 'fail']) {
    test(`physical response replay hardware=${hardware}, ending=${ending}`, async () => {
      const savedRegion = process.env.BABEL_SCROLL_REGIONS;
      const savedRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
      const savedColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
      const write = process.stdout.write;
      const stderr = process.stderr.write;
      const savedLatency = process.env.BABEL_STREAM_LATENCY;
      let diagnostics = '';
      let bytes = '';
      process.env.BABEL_SCROLL_REGIONS = hardware;
      process.env.BABEL_STREAM_LATENCY = '1';
      Object.defineProperty(process.stdout, 'rows', { value: 80, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true });
      OutputBuffer.resetInstance(); resetTerminalProbe();
      process.stdout.write = ((chunk: unknown) => { bytes += String(chunk); return true; }) as typeof write;
      process.stderr.write = ((chunk: unknown) => { diagnostics += String(chunk); return true; }) as typeof stderr;
      const renderer = new ConversationalRenderer({ isTTY: true, ownsInput: false });
      try {
        renderer.start();
        for (let i = 0; i < response.length; i += 11) {
          renderer.onAnswerChunk(response.slice(i, i + 11));
          if (i % 44 === 0) await new Promise((resolve) => setTimeout(resolve, 18));
        }
        if (ending === 'complete') renderer.onSummary();
        else if (ending === 'cancel') renderer.cancelRun();
        else renderer.fail(new Error('Synthetic failure'));
        renderer.onAnswerChunk('LATE_CHUNK_MUST_NOT_APPEAR');
        renderer.stop();
        const grid = createVirtualCellGrid(60, 80);
        grid.apply(bytes);
        const cells = grid.snapshot().lines.join('\n').replace(/\s+/g, ' ');
        for (const sentence of ['Unique first', 'Unique second', 'Unique final sentence.']) {
          assert.equal(cells.split(sentence).length - 1, 1, `${sentence}: ${cells}`);
        }
        assert.doesNotMatch(cells, /LATE_CHUNK|\*\*|`code`|preamble-budget/);
        assert.match(cells, /1\. Unique first.*2\. Unique second/);
        assert.match(renderer.getAnswerText(), /Unique final sentence/);
        assert.equal(diagnostics, '', 'opt-in latency telemetry must use the diagnostic log');
      } finally {
        renderer.stop(); process.stdout.write = write; process.stderr.write = stderr;
        if (savedLatency === undefined) delete process.env.BABEL_STREAM_LATENCY; else process.env.BABEL_STREAM_LATENCY = savedLatency;
        if (savedRegion === undefined) delete process.env.BABEL_SCROLL_REGIONS; else process.env.BABEL_SCROLL_REGIONS = savedRegion;
        if (savedRows) Object.defineProperty(process.stdout, 'rows', savedRows); else Reflect.deleteProperty(process.stdout, 'rows');
        if (savedColumns) Object.defineProperty(process.stdout, 'columns', savedColumns); else Reflect.deleteProperty(process.stdout, 'columns');
        OutputBuffer.resetInstance(); resetTerminalProbe();
      }
    });
  }
}

for (const hardware of ['0', '1']) {
  test(`physical generation and tool seams preserve prior text, hardware=${hardware}`, () => {
    const saved = process.env.BABEL_SCROLL_REGIONS;
    const write = process.stdout.write;
    let bytes = '';
    process.env.BABEL_SCROLL_REGIONS = hardware;
    OutputBuffer.resetInstance(); resetTerminalProbe();
    process.stdout.write = ((chunk: unknown) => { bytes += String(chunk); return true; }) as typeof write;
    const renderer = new ConversationalRenderer({ isTTY: true, ownsInput: false });
    try {
      renderer.start();
      renderer.onAnswerChunk('Alpha before generation.');
      renderer.onAnswerGenerationBoundary();
      renderer.onAnswerChunk('Beta before tool.');
      const tool = renderer.onToolCallStart('read_file', 'fixture.ts');
      renderer.onToolCallComplete(tool, 'inspected fixture');
      renderer.onAnswerChunk('Gamma after tool.');
      renderer.onSummary(); renderer.stop();
      const grid = createVirtualCellGrid(80, 80);
      grid.apply(bytes);
      const cells = grid.snapshot().lines.join('\n').replace(/\s+/g, ' ');
      assert.match(cells, /Alpha before generation\..*Beta before tool\..*Gamma after tool\./);
      for (const phrase of ['Alpha before generation.', 'Beta before tool.', 'Gamma after tool.']) {
        assert.equal(cells.split(phrase).length - 1, 1, cells);
      }
    } finally {
      renderer.stop(); process.stdout.write = write;
      if (saved === undefined) delete process.env.BABEL_SCROLL_REGIONS; else process.env.BABEL_SCROLL_REGIONS = saved;
      OutputBuffer.resetInstance(); resetTerminalProbe();
    }
  });
}

test('mutable preview does not graduate wrapped rows before a resize and commit', () => {
  const saved = process.env.BABEL_SCROLL_REGIONS;
  const original = process.stdout.write;
  process.env.BABEL_SCROLL_REGIONS = '1';
  OutputBuffer.resetInstance(); resetTerminalProbe();
  process.stdout.write = (() => true) as typeof original;
  const region = new TwoRegionStreaming();
  try {
    region.setup(24, 6, 40);
    const answer = Array.from({ length: 30 }, (_, i) => `Sentence ${i}: a paragraph that wraps across several rows.`).join('\n\n');
    region.replaceStreamingContent(renderMarkdown(answer, 40), { deferGraduation: true });
    assert.equal(region.graduatedLineCount, 0);
    region.onResize(24, 20);
    region.replaceStreamingContent(renderMarkdown(answer, 20), { deferGraduation: true });
    assert.equal(region.graduatedLineCount, 0);
    region.commitStreaming();
    assert.equal(region.isActive, false);
  } finally {
    region.teardown(); process.stdout.write = original;
    if (saved === undefined) delete process.env.BABEL_SCROLL_REGIONS; else process.env.BABEL_SCROLL_REGIONS = saved;
    OutputBuffer.resetInstance(); resetTerminalProbe();
  }
});

type ResizeHarness = {
  resize: (cols: number, rows: number) => void;
  flush: () => void;
  region: TwoRegionStreaming | null;
};

function withResizeReplay(hardware: string, run: (renderer: ConversationalRenderer, harness: ResizeHarness, visible: () => string) => void): void {
  const saved = process.env.BABEL_SCROLL_REGIONS;
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const write = process.stdout.write;
  const grid = createVirtualCellGrid(80, 40);
  process.env.BABEL_SCROLL_REGIONS = hardware;
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  OutputBuffer.resetInstance(); resetTerminalProbe();
  process.stdout.write = ((chunk: unknown) => { grid.apply(String(chunk)); return true; }) as typeof write;
  const renderer = new ConversationalRenderer({ isTTY: true, ownsInput: false });
  const internals = renderer as unknown as {
    _handleTerminalResize: (width: number, height: number) => void;
    _twoRegion: TwoRegionStreaming;
    _chunkCoalescer: { flush: () => void };
  };
  try {
    renderer.start();
    run(renderer, {
      resize: (width, height) => {
        Object.defineProperty(process.stdout, 'rows', { value: height, configurable: true });
        Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
        grid.resize(width, height);
        internals._handleTerminalResize(width, height);
      },
      get region() { return internals._twoRegion; },
      flush: () => internals._chunkCoalescer.flush(),
    }, () => grid.snapshot().lines.join('\n').replace(/\s+/g, ' '));
  } finally {
    renderer.stop(); process.stdout.write = write;
    if (saved === undefined) delete process.env.BABEL_SCROLL_REGIONS; else process.env.BABEL_SCROLL_REGIONS = saved;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows); else Reflect.deleteProperty(process.stdout, 'rows');
    if (cols) Object.defineProperty(process.stdout, 'columns', cols); else Reflect.deleteProperty(process.stdout, 'columns');
    OutputBuffer.resetInstance(); resetTerminalProbe();
  }
}

test('fallback resize flushes stable text pending its first paint', () => {
  withResizeReplay('0', (renderer, harness, visible) => {
    renderer.onAnswerChunk('First paragraph.\n\nSecond paragraph.\n');
    harness.resize(80, 40);
    renderer.onSummary(); renderer.stop();
    assert.match(visible(), /First paragraph\..*Second paragraph\./);
    assert.equal(visible().split('First paragraph.').length - 1, 1);
  });
});

for (const firstChunk of [false, true]) {
  test(`resize updates hardware geometry before first paint, firstChunk=${firstChunk}`, () => {
    withResizeReplay('1', (renderer, harness) => {
      if (firstChunk) renderer.onAnswerChunk('Early response.');
      harness.resize(80, 8);
      assert.equal(renderer.isTwoRegionHardwareMode(), false);
      renderer.onSummary();
    });
  });
}

test('hardware height fallback buffers snapshots without appending raw wakeups', () => {
  withResizeReplay('1', (renderer, harness, visible) => {
    renderer.onAnswerChunk('First **formatted** paragraph.\n\n');
    harness.flush();
    harness.resize(80, 12);
    renderer.onAnswerChunk('Final **formatted** sentence.');
    renderer.onSummary(); renderer.stop();
    const text = visible();
    assert.doesNotMatch(text, /\*\*/);
    assert.equal(text.split('Final formatted sentence.').length - 1, 1, text);
    assert.equal(text.split('First formatted paragraph.').length - 1, 1, text);
  });
});

test('an append-only turn never promotes committed text into a mutable snapshot', () => {
  withResizeReplay('1', (renderer, harness) => {
    harness.resize(80, 8);
    renderer.onSummary(); renderer.stop();
    // A fresh renderer starts on the short terminal using the stable protocol.
    renderer = new ConversationalRenderer({ isTTY: true, ownsInput: false });
    try {
      renderer.start();
      renderer.onAnswerChunk('Committed paragraph.\n\nPending paragraph.\n');
      const resize = renderer as unknown as { _handleTerminalResize: (width: number, height: number) => void };
      resize._handleTerminalResize(80, 40);
      assert.equal(renderer.isTwoRegionHardwareMode(), false);
      renderer.onSummary();
    } finally { renderer.stop(); }
  });
});

test('resuming a long live snapshot never graduates mutable rows', () => {
  withResizeReplay('1', (renderer, harness) => {
    renderer.onAnswerChunk(Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.`).join('\n\n'));
    harness.flush();
    renderer.resumeTicks();
    assert.equal(harness.region?.graduatedLineCount, 0);
    renderer.onSummary();
  });
});

test('a short-terminal generation seam clears the prior snapshot before regrowth', () => {
  withResizeReplay('1', (renderer, harness, visible) => {
    renderer.onAnswerChunk('Before shrink.');
    harness.flush(); harness.resize(80, 12);
    renderer.onAnswerGenerationBoundary();
    assert.deepEqual(renderer.getTwoRegionLogicalLines(), []);
    harness.resize(80, 40);
    renderer.onAnswerChunk('After regrowth.');
    renderer.onSummary(); renderer.stop();
    assert.equal(visible().split('Before shrink.').length - 1, 1, visible());
    assert.equal(visible().split('After regrowth.').length - 1, 1, visible());
  });
});

for (const hardware of ['0', '1']) {
  for (const stopWhileFenced of [false, true]) {
    test(`exclusive surface preserves ordered generations hardware=${hardware}, stopWhileFenced=${stopWhileFenced}`, () => {
      withResizeReplay(hardware, (renderer, harness, visible) => {
        const release = suspendActiveRendererForExclusiveSurface();
        try {
          renderer.onAnswerChunk('Alpha before the boundary.\n\nPending Alpha.\n');
          harness.flush();
          renderer.onAnswerGenerationBoundary();
          renderer.onAnswerChunk('Beta after the boundary.\n\nPending Beta.');
          harness.flush();
          assert.doesNotMatch(visible(), /Alpha|Beta/, 'foreign surface owns terminal output');
          if (stopWhileFenced) { renderer.onSummary(); renderer.stop(); }
        } finally { release(); }
        if (!stopWhileFenced) { renderer.onSummary(); renderer.stop(); }
        const text = visible();
        assert.match(text, /Alpha before the boundary\..*Pending Alpha\..*Beta after the boundary\..*Pending Beta\..*Response time/);
        for (const phrase of ['Alpha before the boundary.', 'Pending Alpha.', 'Beta after the boundary.', 'Pending Beta.']) {
          assert.equal(text.split(phrase).length - 1, 1, text);
        }
      });
    });
  }
}

for (const hardware of ['0', '1']) {
  for (const ending of ['cancel', 'fail']) {
    test(`exclusive surface survives resize and ${ending}, hardware=${hardware}`, () => {
      withResizeReplay(hardware, (renderer, harness, visible) => {
        const release = suspendActiveRendererForExclusiveSurface();
        try {
          renderer.onAnswerChunk('Unique text before overlay exit.'); harness.flush();
          harness.resize(80, 8); harness.resize(80, 40);
          if (ending === 'cancel') renderer.cancelRun();
          else renderer.fail(new Error('Synthetic overlay failure'));
          assert.doesNotMatch(visible(), /Unique text|Synthetic overlay failure/);
        } finally { release(); }
        const text = visible();
        assert.equal(text.split('Unique text before overlay exit.').length - 1, 1, text);
        if (ending === 'fail') assert.match(text, /Synthetic overlay failure/);
      });
    });
  }
}

for (const ending of ['complete', 'cancel', 'fail']) {
  test(`a stopped legacy input owner stays stopped after surface release, ${ending}`, () => {
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof write;
    let active = false;
    let enables = 0;
    const renderer = new ConversationalRenderer({ isTTY: true, ownsInput: true });
    Object.defineProperty(renderer, '_rawMode', { value: {
      get isActive() { return active; },
      enable() { active = true; enables++; }, disable() { active = false; }, forceCleanup() { active = false; },
    } });
    let release = () => {};
    try {
      renderer.start(); release = suspendActiveRendererForExclusiveSurface();
      if (ending === 'complete') { renderer.onSummary(); renderer.stop(); }
      else if (ending === 'cancel') renderer.cancelRun();
      else renderer.fail(new Error('Synthetic owner failure'));
      release();
      assert.equal(active, false);
      assert.equal(enables, 1);
    } finally { release(); renderer.stop(); process.stdout.write = write; }
  });
}

for (const fenced of [false, true]) {
  test(`hardware tool failures survive the next preview, fenced=${fenced}`, () => {
    withResizeReplay('1', (renderer, harness, visible) => {
      const release = fenced ? suspendActiveRendererForExclusiveSurface() : () => {};
      try {
        renderer.onAnswerChunk('Before tool.');
        const id = renderer.onToolCallStart('read_file', 'fixture-tool.ts');
        renderer.onToolCallComplete(id, undefined, 'Synthetic read failure', 1);
        renderer.onAnswerChunk('After tool.'); harness.flush();
        renderer.onSummary(); renderer.stop();
      } finally { release(); }
      assert.match(visible(), /fixture-tool\.ts/);
      assert.match(visible(), /Before tool\..*fixture-tool\.ts.*After tool\./);
    });
  });
}

test('a tool-only completion retains transcript and response metadata', () => {
  withResizeReplay('1', (renderer, _harness, visible) => {
    const id = renderer.onToolCallStart('read_file', 'meta.ts');
    renderer.onToolCallComplete(id, undefined, 'Synthetic tool-only failure', 1);
    renderer.onSummary(); renderer.stop();
    assert.match(visible(), /meta\.ts.*Response time/);
  });
});

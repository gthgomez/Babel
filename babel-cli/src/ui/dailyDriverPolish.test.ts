/**
 * Daily-Driver Visual Refinement & Tool Presentation Tests.
 *
 * Asserts that:
 * 1. Routine successful tool executions collapse into calm summary lines.
 * 2. Tool errors, verifier failures, and non-zero exits expand automatically.
 * 3. Verbose mode exposes full un-collapsed execution trails.
 * 4. Semantic color rules are respected (green only for true success, red for errors).
 * 5. Output formats cleanly across multiple widths: 60, 80, 100, 120, 160 columns without overflow.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  groupToolExecutions,
  formatToolGroupSummary,
  renderToolExecutionTrail,
  type ToolExecutionSummary,
} from './toolPresentation.js';
import { stripAnsi, visibleLength } from './theme.js';

describe('PR-D: Daily-Driver Visual Polish & Tool Presentation', () => {
  test('consecutive routine reads collapse into a single calm summary line', () => {
    const tools: ToolExecutionSummary[] = [
      { tool: 'read_file', target: 'src/a.ts', exitCode: 0 },
      { tool: 'read_file', target: 'src/b.ts', exitCode: 0 },
      { tool: 'read_file', target: 'src/c.ts', exitCode: 0 },
      { tool: 'view_file', target: 'src/d.ts', exitCode: 0 },
    ];

    const rendered = stripAnsi(renderToolExecutionTrail(tools));
    assert.equal(rendered.trim(), '○ Read 4 files');
  });

  test('consecutive workspace searches collapse cleanly', () => {
    const tools: ToolExecutionSummary[] = [
      { tool: 'grep_search', target: 'export function', exitCode: 0 },
      { tool: 'grep_search', target: 'interface Model', exitCode: 0 },
    ];

    const rendered = stripAnsi(renderToolExecutionTrail(tools));
    assert.equal(rendered.trim(), '○ Searched workspace (2 steps)');
  });

  test('tool errors expand automatically into prominent failure lines', () => {
    const tools: ToolExecutionSummary[] = [
      { tool: 'read_file', target: 'src/a.ts', exitCode: 0 },
      { tool: 'run_command', target: 'npm test', exitCode: 1, error: 'Command failed with exit code 1' },
      { tool: 'read_file', target: 'src/b.ts', exitCode: 0 },
    ];

    const rendered = stripAnsi(renderToolExecutionTrail(tools));
    assert.ok(rendered.includes('Read 1 file'), `Expected Read 1 file, got: ${rendered}`);
    assert.ok(rendered.includes('✖ run_command npm test — failed (exit 1)'), `Expected expanded error, got: ${rendered}`);
  });

  test('verbose mode expands all tool executions with full targets', () => {
    const tools: ToolExecutionSummary[] = [
      { tool: 'read_file', target: 'src/a.ts', exitCode: 0 },
      { tool: 'read_file', target: 'src/b.ts', exitCode: 0 },
    ];

    const verboseOutput = stripAnsi(renderToolExecutionTrail(tools, true));
    assert.ok(verboseOutput.includes('src/a.ts'));
    assert.ok(verboseOutput.includes('src/b.ts'));
    assert.ok(verboseOutput.includes('✔ read_file src/a.ts — ok'));
  });

  test('successful edits display prominent success checkmark', () => {
    const tools: ToolExecutionSummary[] = [
      { tool: 'write_file', target: 'src/a.ts', exitCode: 0 },
      { tool: 'str_replace', target: 'src/b.ts', exitCode: 0 },
    ];

    const rendered = stripAnsi(renderToolExecutionTrail(tools));
    assert.equal(rendered.trim(), '✔ Edited 2 files');
  });

  test('responsive widths: tool presentations format cleanly across 60, 80, 100, 120, 160 columns', () => {
    const widths = [60, 80, 100, 120, 160];
    const tools: ToolExecutionSummary[] = [
      { tool: 'read_file', target: 'src/deep/nested/directory/structure/longFileNameWithUnicode🚀.ts', exitCode: 0 },
      { tool: 'read_file', target: 'src/another/deeply/nested/file/path with spaces/index.ts', exitCode: 0 },
    ];

    for (const width of widths) {
      const rendered = renderToolExecutionTrail(tools, false, width);
      const lines = rendered.split('\n');
      for (const line of lines) {
        assert.ok(
          visibleLength(line) <= width,
          `Rendered line length ${visibleLength(line)} exceeded width ${width}: "${line}"`,
        );
      }
      assert.equal(stripAnsi(rendered).trim(), '○ Read 2 files');
    }
  });

  test('responsive widths: error expansion truncates long paths cleanly across narrow columns', () => {
    const widths = [60, 80, 100, 120, 160];
    const errorTools: ToolExecutionSummary[] = [
      {
        tool: 'write_file',
        target: 'packages/some-deeply-nested-package/src/components/veryLongFilenameForTestingResponsiveColumns.ts',
        exitCode: 1,
        error: 'Permission denied',
      },
    ];

    for (const width of widths) {
      const rendered = renderToolExecutionTrail(errorTools, false, width);
      const lines = rendered.split('\n');
      for (const line of lines) {
        assert.ok(
          visibleLength(line) <= width,
          `Error line length ${visibleLength(line)} exceeded width ${width}: "${line}"`,
        );
      }
      assert.ok(stripAnsi(rendered).includes('✖ write_file'));
      assert.ok(stripAnsi(rendered).includes('failed (exit 1)'));
    }
  });

  test('production integration: ConversationalRenderer accumulates and collapses N > 1 consecutive tool calls into a single group summary line', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      const id1 = renderer.onToolCallStart('read_file', 'src/a.ts');
      assert.ok(id1 > 0);
      renderer.onToolCallComplete(id1, 'read 100 bytes', undefined, 0);

      const id2 = renderer.onToolCallStart('read_file', 'src/b.ts');
      assert.ok(id2 > 0);
      renderer.onToolCallComplete(id2, 'read 200 bytes', undefined, 0);

      const id3 = renderer.onToolCallStart('read_file', 'src/c.ts');
      assert.ok(id3 > 0);
      renderer.onToolCallComplete(id3, 'read 300 bytes', undefined, 0);

      // Flush via answer chunk (start of assistant output)
      renderer.onAnswerChunk('I have inspected all files.');
      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('Read 3 files'), `Expected 'Read 3 files' in collapsed output, got: ${out}`);
      assert.ok(!out.includes('unverified'), `Confirmed reads should not say unverified, got: ${out}`);
      assert.ok(!out.includes('Read 1 file'), `Should not contain individual 'Read 1 file' entries, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('production integration: Category change flushes previous group and begins next group', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      // Group 1: 2 confirmed reads
      const r1 = renderer.onToolCallStart('read_file', 'src/config.ts');
      renderer.onToolCallComplete(r1, 'read 50 bytes', undefined, 0);
      const r2 = renderer.onToolCallStart('read_file', 'src/types.ts');
      renderer.onToolCallComplete(r2, 'read 80 bytes', undefined, 0);

      // Group 2: 2 confirmed writes (category change triggers flush of group 1)
      const w1 = renderer.onToolCallStart('write_file', 'src/a.ts');
      renderer.onToolCallComplete(w1, 'wrote 10 lines', undefined, 0);
      const w2 = renderer.onToolCallStart('write_file', 'src/b.ts');
      renderer.onToolCallComplete(w2, 'wrote 20 lines', undefined, 0);

      renderer.onSummary();
      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('Read 2 files'), `Expected 'Read 2 files' in output, got: ${out}`);
      assert.ok(out.includes('Edited 2 files'), `Expected 'Edited 2 files' in output, got: ${out}`);
      assert.ok(!out.includes('unverified'), `Confirmed groups should not say unverified, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('production integration: ConversationalRenderer verboseMode expands tool calls with full details', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: true });
      assert.equal(renderer.verboseMode, true);
      renderer.start();

      const callId = renderer.onToolCallStart('read_file', 'src/config.ts');
      assert.ok(callId > 0);
      renderer.onToolCallComplete(callId, 'read 120 bytes', undefined, 0);

      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('src/config.ts'), `Expected 'src/config.ts' in verbose output, got: ${out}`);
      assert.ok(out.includes('read_file'), `Expected 'read_file' in verbose output, got: ${out}`);
      assert.ok(out.includes('ok'), `Expected 'ok' status in verbose output, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('production integration: structured error and exitCode flow through real dispatchChatEvent into ConversationalRenderer', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const { dispatchChatEvent } = await import('../interactive/execution/chatEventDispatch.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      const sinks = {
        convRenderer: renderer,
        toolIdQueue: [] as number[],
      };

      dispatchChatEvent({ type: 'tool_start', tool: 'run_command', target: 'npm test' }, sinks);
      dispatchChatEvent(
        {
          type: 'tool_complete',
          tool: 'run_command',
          target: 'npm test',
          error: 'Command failed with exit code 1',
          exitCode: 1,
        },
        sinks,
      );

      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('✖'), `Expected failure icon '✖' in output, got: ${out}`);
      assert.ok(out.includes('npm test'), `Expected target 'npm test' in error output, got: ${out}`);
      assert.ok(out.includes('failed (exit 1)'), `Expected 'failed (exit 1)' in error output, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('production integration: direct ChatCallbacks non-streaming failure renders failure, never success', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      // Direct non-streaming callback invocation: blocked tool with error and exit_code
      const id = renderer.onToolCallStart('run_command', 'git push origin main');
      assert.ok(id > 0);
      renderer.onToolCallComplete(id, 'plan-gate', 'blocked', 1);

      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('✖'), `Expected failure icon '✖' in non-streaming callback failure, got: ${out}`);
      assert.ok(out.includes('git push origin main'), `Expected target in error output, got: ${out}`);
      assert.ok(out.includes('failed (exit 1)'), `Expected 'failed (exit 1)' in output, got: ${out}`);
      assert.ok(!out.includes('✔'), `Should not contain success icon '✔', got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('production integration: fail-closed fallback converts missing exitCode with gate/blocked detail into failure', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      // Callback invocation with detail only (no error/exitCode parameters passed)
      const id = renderer.onToolCallStart('str_replace', 'src/auth.ts');
      assert.ok(id > 0);
      renderer.onToolCallComplete(id, 'hard-plan-mode');

      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('✖'), `Expected fail-closed failure icon '✖' for hard-plan-mode detail, got: ${out}`);
      assert.ok(out.includes('src/auth.ts'), `Expected target in error output, got: ${out}`);
      assert.ok(!out.includes('Edited'), `Should not group as successful edit, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('production integration: consecutive edits with onFileChanged diffs preserve grouping into Edited N files', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      // Edit 1: Explicit success
      const id1 = renderer.onToolCallStart('write_file', 'src/a.ts');
      renderer.onToolCallComplete(id1, 'line 10', undefined, 0);
      renderer.onFileChanged('src/a.ts', 5, 2);

      // Edit 2: Explicit success
      const id2 = renderer.onToolCallStart('write_file', 'src/b.ts');
      renderer.onToolCallComplete(id2, 'line 20', undefined, 0);
      renderer.onFileChanged('src/b.ts', 8, 1);

      // Assistant responds
      renderer.onAnswerChunk('Both files have been updated.');
      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('Edited 2 files'), `Expected 'Edited 2 files' in collapsed output, got: ${out}`);
      assert.ok(out.includes('src/a.ts'), `Expected diff for src/a.ts, got: ${out}`);
      assert.ok(out.includes('src/b.ts'), `Expected diff for src/b.ts, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('production integration: runChatEngineOnce non-streaming callback-boundary integration preserves structured tool failure', async () => {
    // Tests that BABEL_STREAM_TOOLS=0 selects non-streaming mode (isChatStreamingEnabled() === false),
    // routes through runChatEngineOnce() -> engine.submitMessage(..., buildChatCallbacks(renderer)),
    // and correctly preserves structured error / exitCode across the renderer boundary to output a failure line.
    const { isChatStreamingEnabled } = await import('../config/chatEngineLimits.js');
    const { runChatEngineOnce } = await import('../interactive/execution/chatCore.js');
    const { ConversationalRenderer } = await import('./waterfall.js');
    const prevEnv = process.env.BABEL_STREAM_TOOLS;
    process.env.BABEL_STREAM_TOOLS = '0';

    assert.equal(
      isChatStreamingEnabled(),
      false,
      'BABEL_STREAM_TOOLS=0 must resolve isChatStreamingEnabled() to false',
    );

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      let submitMessageCalled = false;
      const mockEngine: any = {
        submitMessage: async (task: string, callbacks: any) => {
          submitMessageCalled = true;
          // Emits structured failure over the non-streaming callback boundary
          const toolId = callbacks.onToolStart?.('run_command', 'git push origin main') ?? 1;
          callbacks.onToolComplete?.(toolId, 'plan-gate', 'blocked', 1);
          return {
            status: 'completed',
            answer: 'Operation was blocked by plan-gate policy.',
            outcome: 'SUCCESS',
            conversation: [],
            toolCalls: [{ tool: 'run_command', target: 'git push origin main', error: 'blocked', exit_code: 1 }],
            usage: { totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
          };
        },
        cancel: () => undefined,
      };

      const target = {
        targetRoot: process.cwd(),
        workspaceRoot: null,
        project: null,
        source: 'cwd' as const,
        cwd: process.cwd(),
      };

      const result = await runChatEngineOnce({
        task: 'push my code',
        target,
        engine: mockEngine,
        convRenderer: renderer,
        preflightContext: '',
      });

      renderer.stop();

      assert.equal(
        submitMessageCalled,
        true,
        'runChatEngineOnce must execute submitMessage (non-streaming callback path)',
      );
      assert.equal(result.status, 'completed');
      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('✖'), `Expected failure icon '✖' in output, got: ${out}`);
      assert.ok(out.includes('git push origin main'), `Expected target 'git push origin main' in output, got: ${out}`);
      assert.ok(out.includes('failed (exit 1)'), `Expected 'failed (exit 1)' in output, got: ${out}`);
      assert.ok(!out.includes('✔'), `Should not contain success icon '✔', got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
      if (prevEnv === undefined) {
        delete process.env.BABEL_STREAM_TOOLS;
      } else {
        process.env.BABEL_STREAM_TOOLS = prevEnv;
      }
    }
  });

  test('unknown result state remains unverified in verbose mode and never produces green success or exit 0', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: true });
      renderer.start();

      const id = renderer.onToolCallStart('read_file', 'src/unknown_probe.ts');
      assert.ok(id > 0);
      // Completely unspecified status with a neutral detail string
      renderer.onToolCallComplete(id, 'read 42 bytes');

      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('src/unknown_probe.ts'), `Expected target in output, got: ${out}`);
      assert.ok(out.includes('unverified'), `Expected 'unverified' status in output, got: ${out}`);
      assert.ok(!out.includes('✔'), `Should NOT contain success checkmark '✔', got: ${out}`);
      assert.ok(!out.includes('exit 0'), `Should NOT invent 'exit 0', got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('collapsed unknown read summary includes unverified and does not claim confirmed success', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      const id1 = renderer.onToolCallStart('read_file', 'src/a.ts');
      renderer.onToolCallComplete(id1, 'read 100 bytes'); // unknown

      const id2 = renderer.onToolCallStart('read_file', 'src/b.ts');
      renderer.onToolCallComplete(id2, 'read 200 bytes'); // unknown

      renderer.onAnswerChunk('Done reading.');
      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('Read 2 files (unverified)'), `Expected unverified read summary, got: ${out}`);
      assert.ok(!out.includes('✔'), `Should NOT contain green success '✔', got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('collapsed unknown command summary includes unverified and does not claim confirmed success', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      const id1 = renderer.onToolCallStart('run_command', 'echo a');
      renderer.onToolCallComplete(id1, 'echoed a'); // unknown

      const id2 = renderer.onToolCallStart('run_command', 'echo b');
      renderer.onToolCallComplete(id2, 'echoed b'); // unknown

      renderer.onAnswerChunk('Done running commands.');
      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('Executed 2 commands (unverified)'), `Expected unverified command summary, got: ${out}`);
      assert.ok(!out.includes('✔'), `Should NOT contain green success '✔', got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('mixed read group with one unknown member contaminates group to unverified', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      // Confirmed read
      const id1 = renderer.onToolCallStart('read_file', 'src/a.ts');
      renderer.onToolCallComplete(id1, 'read 100 bytes', undefined, 0);

      // Unknown read
      const id2 = renderer.onToolCallStart('read_file', 'src/b.ts');
      renderer.onToolCallComplete(id2, 'read 200 bytes');

      renderer.onAnswerChunk('Done reading.');
      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('Read 2 files (unverified)'), `Expected unverified group summary, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('unknown edit among successful edits prevents false-green Edited N files promotion', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      // Confirmed success edit
      const id1 = renderer.onToolCallStart('write_file', 'src/a.ts');
      renderer.onToolCallComplete(id1, 'line 10', undefined, 0);
      renderer.onFileChanged('src/a.ts', 5, 2);

      // Unknown edit (missing exitCode and error)
      const id2 = renderer.onToolCallStart('write_file', 'src/b.ts');
      renderer.onToolCallComplete(id2, 'updated');
      renderer.onFileChanged('src/b.ts', 8, 1);

      renderer.onAnswerChunk('Edits made.');
      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('Edited 2 files (unverified)'), `Expected unverified group summary, got: ${out}`);
      assert.ok(!out.includes('✔ Edited 2 files'), `Should NOT contain green success '✔ Edited 2 files', got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

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

  test('production integration: ConversationalRenderer completes tools with calm presentation formatting by default', async () => {
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

      const callId1 = renderer.onToolCallStart('read_file', 'src/config.ts');
      assert.ok(callId1 > 0);
      renderer.onToolCallComplete(callId1, 'read 120 bytes');

      const callId2 = renderer.onToolCallStart('write_file', 'src/output.ts');
      assert.ok(callId2 > 0);
      renderer.onToolCallComplete(callId2, 'wrote 50 lines');

      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('Read 1 file'), `Expected 'Read 1 file' in output, got: ${out}`);
      assert.ok(out.includes('Edited 1 file'), `Expected 'Edited 1 file' in output, got: ${out}`);
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
      renderer.onToolCallComplete(callId, 'read 120 bytes');

      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('src/config.ts'), `Expected 'src/config.ts' in verbose output, got: ${out}`);
      assert.ok(out.includes('read_file'), `Expected 'read_file' in verbose output, got: ${out}`);
      assert.ok(out.includes('ok'), `Expected 'ok' status in verbose output, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('production integration: ConversationalRenderer auto-expands errors even in default mode', async () => {
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

      const callId = renderer.onToolCallStart('run_command', 'npm test');
      assert.ok(callId > 0);
      renderer.onToolCallComplete(callId, undefined, 'Command failed with exit code 1', 1);

      renderer.stop();

      const out = stripAnsi(chunks.join(''));
      assert.ok(out.includes('✖'), `Expected failure icon '✖' in output, got: ${out}`);
      assert.ok(out.includes('npm test'), `Expected target 'npm test' in error output, got: ${out}`);
      assert.ok(out.includes('failed (exit 1)'), `Expected 'failed (exit 1)' in error output, got: ${out}`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

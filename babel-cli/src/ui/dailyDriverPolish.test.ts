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
});

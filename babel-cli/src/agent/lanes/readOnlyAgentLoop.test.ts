import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ToolContext, ToolResult } from '../../localTools.js';
import type { AgentAction } from '../actions.js';
import {
  buildToolCallLogFromSteps,
  formatReadOnlyObservations,
  mergeDiscoveryAndSynthesisSessionSteps,
  runReadOnlyAgentLoop,
} from './readOnlyAgentLoop.js';
import type { ToolExecutor } from '../toolExecutor.js';
import { createLiteToolStreamSink } from '../../ui/liteToolStream.js';

function mockExecutor(results: Record<string, ToolResult>): ToolExecutor {
  return {
    mapAction(action: AgentAction) {
      if (action.type === 'read_file') {
        return [{ kind: 'execute', request: { tool: 'file_read', path: action.path } }];
      }
      if (action.type === 'list_dir') {
        return [{ kind: 'execute', request: { tool: 'directory_list', path: action.path } }];
      }
      if (action.type === 'finish' || action.type === 'ask_approval') {
        return [{ kind: 'terminal', action }];
      }
      return [];
    },
    async execute(action: AgentAction, _context: ToolContext) {
      if (action.type === 'finish' || action.type === 'ask_approval') {
        return { action, terminal: true, results: [] };
      }
      const key =
        action.type === 'read_file'
          ? `read:${action.path}`
          : action.type === 'list_dir'
            ? `list:${action.path}`
            : action.type;
      const result = results[key] ?? {
        exit_code: 0,
        stdout: 'ok',
        stderr: '',
      };
      return { action, terminal: false, results: [result] };
    },
  };
}

describe('runReadOnlyAgentLoop', () => {
  it('runs deterministic mock discovery and records tool_call_log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-readonly-loop-'));
    writeFileSync(join(root, 'README.md'), '# Demo\n', 'utf-8');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.js'), 'export function add(a,b){return a+b;}\n', 'utf-8');

    const result = await runReadOnlyAgentLoop({
      verb: 'plan',
      task: 'Explain the math helper',
      projectRoot: root,
      seedPaths: ['src/math.js'],
      toolContext: {
        agentId: 'test-plan',
        runId: 'run-test',
        babelRoot: root,
      },
      provider: 'mock',
      useDeterministicMock: true,
      executor: mockExecutor({
        'list:.': { exit_code: 0, stdout: 'README.md\nsrc/', stderr: '' },
        'read:src/math.js': { exit_code: 0, stdout: 'export function add', stderr: '' },
      }),
    });

    assert.ok(result.toolCallLog.length >= 2);
    assert.ok(result.observations.includes('file_read'));
    assert.equal(result.policyBlocked, false);
    assert.equal(result.degraded, false);
    assert.ok(result.sessionLoopSteps.some((step) => step.phase === 'finish'));
  });

  it('mock discovery reads PROJECT_CONTEXT and stack manifests when present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-readonly-anchor-loop-'));
    writeFileSync(join(root, 'PROJECT_CONTEXT.md'), '# Context\n', 'utf-8');
    writeFileSync(join(root, 'project.godot'), '[application]\n', 'utf-8');

    const result = await runReadOnlyAgentLoop({
      verb: 'plan',
      task: 'plan next features',
      projectRoot: root,
      toolContext: {
        agentId: 'test-plan-anchor',
        runId: 'run-anchor',
        babelRoot: root,
      },
      provider: 'mock',
      useDeterministicMock: true,
      executor: mockExecutor({
        'list:.': { exit_code: 0, stdout: 'PROJECT_CONTEXT.md\nproject.godot\n', stderr: '' },
        'read:PROJECT_CONTEXT.md': { exit_code: 0, stdout: '# Context', stderr: '' },
        'read:project.godot': { exit_code: 0, stdout: '[application]', stderr: '' },
      }),
    });

    const targets = result.toolCallLog.map((entry) => entry.target);
    assert.ok(targets.includes('PROJECT_CONTEXT.md'));
    assert.ok(targets.includes('project.godot'));
  });

  it('emits tool stream events for executed discovery tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-readonly-tool-stream-'));
    writeFileSync(join(root, 'README.md'), '# Demo\n', 'utf-8');
    const toolEvents: string[] = [];
    const toolStream = createLiteToolStreamSink({
      progress: {
        reportToolCall(event) {
          toolEvents.push(`${event.tool}:${event.status}`);
        },
      },
    });

    await runReadOnlyAgentLoop({
      verb: 'plan',
      task: 'Explain the repo',
      projectRoot: root,
      toolContext: {
        agentId: 'test-tool-stream',
        runId: 'run-tool-stream',
        babelRoot: root,
      },
      provider: 'mock',
      useDeterministicMock: true,
      toolStream,
      executor: mockExecutor({
        'list:.': { exit_code: 0, stdout: 'README.md\n', stderr: '' },
        'read:README.md': { exit_code: 0, stdout: '# Demo', stderr: '' },
      }),
    });

    assert.ok(toolEvents.some((entry) => entry.startsWith('directory_list:running')));
    assert.ok(
      toolEvents.some(
        (entry) =>
          entry.startsWith('directory_list:pass') || entry.startsWith('directory_list:fail'),
      ),
    );
  });

  it('fix discovery mock loop records semantic_search and grep tool calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-readonly-fix-loop-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.js'), 'export function add(a,b){return a+b;}\n', 'utf-8');

    const result = await runReadOnlyAgentLoop({
      verb: 'fix',
      task: 'fix the failing math test',
      projectRoot: root,
      seedPaths: ['src/math.js'],
      toolContext: {
        agentId: 'test-fix',
        runId: 'run-fix',
        babelRoot: root,
      },
      provider: 'mock',
      useDeterministicMock: true,
    });

    const tools = result.toolCallLog.map((entry) => entry.tool);
    assert.ok(tools.includes('semantic_search'));
    assert.ok(tools.includes('grep'));
  });

  it('marks policy-blocked writes as blocked terminal steps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-readonly-loop-deny-'));
    const { executeActionWithPolicy } = await import('../toolExecutor.js');
    const writeAttempt = await executeActionWithPolicy(
      { type: 'write_file', path: 'blocked.txt', content: 'nope' },
      'read_only',
      {
        agentId: 'test-ask',
        runId: 'run-deny',
        babelRoot: root,
      },
    );
    assert.equal(writeAttempt.policyBlocked, true);
    assert.equal(writeAttempt.policyDecision, 'deny');
  });
});

describe('readOnlyAgentLoop helpers', () => {
  it('merges discovery and synthesis session steps', () => {
    const merged = mergeDiscoveryAndSynthesisSessionSteps({
      discoverySteps: [
        { phase: 'observe', status: 'pass', policy_decision: 'allow' },
        { phase: 'finish', status: 'pass', policy_decision: 'allow' },
      ],
      act: 'pass',
      verify: 'pass',
      terminal: 'finish',
    });
    assert.equal(merged.filter((step) => step.phase === 'observe').length, 1);
    assert.equal(merged.filter((step) => step.phase === 'act').length, 1);
    assert.equal(merged.at(-1)?.phase, 'finish');
  });

  it('formats observations from executed steps', () => {
    const text = formatReadOnlyObservations([
      {
        phase: 'observe',
        action: { type: 'read_file', path: 'README.md' },
        policyDecision: 'allow',
        policyBlocked: false,
        toolResults: [{ exit_code: 0, stdout: '# Title', stderr: '' }],
      },
    ]);
    assert.match(text, /README\.md/);
    assert.match(text, /# Title/);
  });

  it('builds tool call log entries with step numbers', () => {
    const log = buildToolCallLogFromSteps([
      {
        phase: 'observe',
        action: { type: 'list_dir', path: '.' },
        policyDecision: 'allow',
        policyBlocked: false,
        toolResults: [{ exit_code: 0, stdout: 'src/', stderr: '' }],
      },
    ]);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.tool, 'directory_list');
    assert.equal(log[0]?.step, 1);
  });
});

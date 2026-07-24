/**
 * Tests for TaskIntent classification and completion gate logic.
 */
import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import { ChatEngine, type TaskIntent } from './chatEngine.js';
import { hasSubAgentWrites } from './chatEngineCriticBudget.js';
import { extractVerifierCommand } from './chatEngineVerifierSession.js';
import type { ChatTurn } from './chatToolDefinitions.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Intent classifier tests ───────────────────────────────────────────────

describe('ChatEngine.classifyChatTaskIntent', () => {
  test('classifies fix verb as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('fix the login bug'), 'execute');
  });

  test('classifies repair as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('repair the broken test'), 'execute');
  });

  test('classifies implement as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('implement user authentication'), 'execute');
  });

  test('classifies create a file as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('create a new component for the dashboard'), 'execute');
  });

  test('classifies write a function as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('write a helper function'), 'execute');
  });

  test('classifies patch as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('apply the patch to fix the vulnerability'), 'execute');
  });

  test('classifies run npm test as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('run npm test and fix failures'), 'execute');
  });

  test('classifies refactor as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('refactor the auth module'), 'execute');
  });

  test('classifies change/modify as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('change the config to use port 3000'), 'execute');
  });

  test('classifies remove as execute', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('remove the deprecated endpoint'), 'execute');
  });

  test('classifies diff/code fence as execute', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('Here is a fix:\n```diff\n- old\n+ new\n```'),
      'execute',
    );
  });

  test('classifies what-does question as explain', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('what does this function do?'), 'explain');
  });

  test('classifies how-to question as explain', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('how does the router work?'), 'explain');
  });

  test('classifies why question as explain', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('why is this test failing?'), 'explain');
  });

  test('classifies explain as explain', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('explain the authentication flow'), 'explain');
  });

  test('classifies review as explain', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('review the auth module'), 'explain');
  });

  test('classifies analyze/diagnose as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('diagnose the slow database query'),
      'explain',
    );
  });

  test('classifies find/search as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('find where authentication logic is implemented'),
      'explain',
    );
  });

  test('classifies review-and-fix as execute (fix overrides review)', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('review the auth module and fix any bugs'),
      'execute',
    );
  });

  test('classifies defaults to execute for ambiguous prompts', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('the login page is broken'), 'execute');
  });

  test('classifies can you explain question as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('can you explain how middleware works?'),
      'explain',
    );
  });

  test('classifies describe as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('describe the project structure'),
      'explain',
    );
  });

  test('classifies tell me about as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('tell me about the database schema'),
      'explain',
    );
  });

  test('classifies document/summarize as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('document the API endpoints'),
      'explain',
    );
  });

  test('classifies compare as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('compare the error-handling options in option-a and option-b'),
      'explain',
    );
  });

  test('classifies contrast as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('contrast the two authentication approaches'),
      'explain',
    );
  });

  test('classifies evaluate as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('evaluate the performance of the caching layer'),
      'explain',
    );
  });

  test('classifies assess as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('assess the security of the login flow'),
      'explain',
    );
  });

  test('classifies report tradeoffs as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('report tradeoffs between the two designs'),
      'explain',
    );
  });

  test('classifies PAR-A05 full task as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent(
        'Compare the error-handling options in docs/option-a.md and docs/option-b.md. Report tradeoffs and verification steps without editing source files.',
      ),
      'explain',
    );
  });

  test('classifies without editing as explain (no-edit directive)', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('fix the bug without editing any source files'),
      'explain',
    );
  });

  test('classifies without modifying as explain (no-edit directive)', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('review the code without modifying anything'),
      'explain',
    );
  });

  test('classifies read-only as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('read-only review of the pull request'),
      'explain',
    );
  });

  test('classifies do not edit as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('analyze the performance but do not edit any files'),
      'explain',
    );
  });

  test('classifies compare+fix override as execute', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('compare the two options and fix the worse one'),
      'execute',
    );
  });

  test('classifies report (standalone) defaults to execute', () => {
    // "report" alone (without "tradeoffs"/"findings"/"back"/"on") is ambiguous
    assert.equal(
      ChatEngine.classifyChatTaskIntent('report the bug count'),
      'execute',
    );
  });

  test('classifies read file as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('Read the file src/README.md and tell me what it says'),
      'explain',
    );
  });

  test('classifies list files as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('List the files in the src/ directory'),
      'explain',
    );
  });

  test('classifies show contents as explain', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('Show me the contents of config.json'),
      'explain',
    );
  });

  test('classifies cat as explain', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('cat package.json'), 'explain');
  });

  test('classifies head/tail as explain', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('head -20 src/app.ts'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('tail the log file'), 'explain');
  });

  test('classifies display/print as explain', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('display the contents of app.ts'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('print the environment variables'), 'explain');
  });

  test('classifies read-and-fix as execute (edit overrides read)', () => {
    assert.equal(
      ChatEngine.classifyChatTaskIntent('Read the error log and fix the bug'),
      'execute',
    );
    assert.equal(
      ChatEngine.classifyChatTaskIntent('list the broken files then fix them'),
      'execute',
    );
    assert.equal(
      ChatEngine.classifyChatTaskIntent('show the config and then edit it'),
      'execute',
    );
  });
});

// ─── Gate logic tests ──────────────────────────────────────────────────────

describe('Completion gate logic', () => {
  let engine: ChatEngine;

  beforeEach(() => {
    engine = new ChatEngine({
      task: 'fix the failing test in src/math.js',
      projectRoot: '/tmp/test-project',
    });
  });

  test('gate rejects completion with no tool calls', () => {
    const turn: ChatTurn = { type: 'completion', answer: 'You should change the multiply function.' };
    // Access private method via type assertion for testing
    const result = (engine as any).evaluateCompletionGate(turn, 'execute' as TaskIntent);
    assert.equal(result, 'reject');
  });

  test('gate allows completion for explain intent regardless of tools', () => {
    const turn: ChatTurn = { type: 'completion', answer: 'The function works like this...' };
    const result = (engine as any).evaluateCompletionGate(turn, 'explain' as TaskIntent);
    assert.equal(result, 'allow');
  });

  test('gate allows non-completion turns (tool_calls)', () => {
    const turn: ChatTurn = {
      type: 'tool_calls',
      thinking: 'Reading the file...',
      actions: [
        {
          type: 'read_file',
          path: '/tmp/test-project/src/math.js',
        } as any,
      ],
    };
    const result = (engine as any).evaluateCompletionGate(turn, 'execute' as TaskIntent);
    assert.equal(result, 'allow');
  });

  test('classifier type guard returns valid TaskIntent', () => {
    const result = ChatEngine.classifyChatTaskIntent('fix this bug');
    assert.ok(result === 'execute' || result === 'explain');
  });
});

// ─── Positive-path gate tests ────────────────────────────────────────────────
// These verify the gate correctly detects writes in toolCallLog, covering
// the tool name mismatch bug (file_write vs write_file) and sub-agent writes.

function pushToolLog(engine: ChatEngine, entry: Record<string, unknown>) {
  (engine as any).toolCallLog.push({
    tool: 'unknown',
    target: '',
    index: 0,
    exit_code: 0,
    ...entry,
  });
}

describe('Completion gate — positive paths', () => {
  let engine: ChatEngine;

  beforeEach(() => {
    engine = new ChatEngine({
      task: 'fix the failing test in src/math.js',
      projectRoot: '/tmp/test-project',
    });
  });

  test('gate allows completion after successful write_file + verifier', () => {
    pushToolLog(engine, { tool: 'write_file', target: '/tmp/test-project/src/math.js' });
    // 'required' policy needs a verifier attempt — green in log suffices
    pushToolLog(engine, { tool: 'test_run', target: 'npm test', exit_code: 0 });
    const turn: ChatTurn = { type: 'completion', answer: 'Fixed the test.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'allow');
  });

  test('gate accepts legacy file_write string (backward-compat) with verifier', () => {
    pushToolLog(engine, { tool: 'file_write', target: '/tmp/test-project/src/math.js' });
    pushToolLog(engine, { tool: 'test_run', target: 'npm test', exit_code: 0 });
    const turn: ChatTurn = { type: 'completion', answer: 'Fixed.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'allow');
  });

  test('gate allows completion after apply_patch + verifier', () => {
    pushToolLog(engine, { tool: 'apply_patch', target: '/tmp/test-project/src/math.js' });
    pushToolLog(engine, { tool: 'test_run', target: 'npm test', exit_code: 0 });
    const turn: ChatTurn = { type: 'completion', answer: 'Patched.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'allow');
  });

  test('gate rejects write without any verifier attempt (required policy)', () => {
    // The new 'required' policy demands at least a verifier attempt before completion.
    pushToolLog(engine, { tool: 'write_file', target: '/tmp/test-project/src/math.js' });
    const turn: ChatTurn = { type: 'completion', answer: 'Fixed without verification.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'reject');
  });

  // str_replace is the preferred edit primitive and must satisfy the gate
  test('gate allows completion after successful str_replace + verifier', () => {
    pushToolLog(engine, { tool: 'str_replace', target: '/tmp/test-project/src/math.js' });
    pushToolLog(engine, { tool: 'test_run', target: 'npm test', exit_code: 0 });
    const turn: ChatTurn = { type: 'completion', answer: 'Replaced the broken line.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'allow');
  });

  test('gate rejects str_replace that was policy-blocked', () => {
    pushToolLog(engine, {
      tool: 'str_replace',
      target: '/tmp/test-project/src/math.js',
      error: 'blocked',
    });
    const turn: ChatTurn = { type: 'completion', answer: 'Tried str_replace but blocked.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'reject');
  });

  test('gate rejects failed str_replace (anchor miss) without other writes', () => {
    pushToolLog(engine, {
      tool: 'str_replace',
      target: '/tmp/test-project/src/math.js',
      error: 'str_replace: old_str not found',
      exit_code: 1,
    });
    const turn: ChatTurn = { type: 'completion', answer: 'I tried to edit but anchor missed.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'reject');
  });

  test('hasAnyWrites true after str_replace', () => {
    pushToolLog(engine, { tool: 'str_replace', target: '/tmp/test-project/src/math.js' });
    assert.equal((engine as any).hasAnyWrites(), true);
  });

  test('gate rejects write_file that was policy-blocked', () => {
    pushToolLog(engine, { tool: 'write_file', target: '/tmp/test-project/src/math.js', error: 'blocked' });
    const turn: ChatTurn = { type: 'completion', answer: 'Tried to fix but was blocked.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'reject');
  });

  test('gate allows after sub_agent with changed files + verifier', () => {
    pushToolLog(engine, { tool: 'sub_agent', target: 'fix the thing', detail: '3 steps, 2 changed' });
    pushToolLog(engine, { tool: 'test_run', target: 'npm test', exit_code: 0 });
    const turn: ChatTurn = { type: 'completion', answer: 'Sub-agent applied fix.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'allow');
  });

  test('gate rejects sub_agent with 0 changed files', () => {
    pushToolLog(engine, { tool: 'sub_agent', target: 'fix the thing', detail: '3 steps, 0 changed' });
    const turn: ChatTurn = { type: 'completion', answer: 'Sub-agent found nothing.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'reject');
  });

  test('gate rejects completion with only read_file in log', () => {
    pushToolLog(engine, { tool: 'read_file', target: '/tmp/test-project/src/math.js' });
    const turn: ChatTurn = { type: 'completion', answer: 'You should fix the file.' };
    assert.equal((engine as any).evaluateCompletionGate(turn, 'execute'), 'reject');
  });

  test('gate requires verifier when task asks to run tests', () => {
    const verifyEngine = new ChatEngine({
      task: 'fix the bug and run npm test after making changes',
      projectRoot: '/tmp/test-project',
    });
    pushToolLog(verifyEngine, { tool: 'write_file', target: '/tmp/test-project/src/math.js' });
    // Has write but no green verifier — task explicitly asks for tests
    const turn: ChatTurn = { type: 'completion', answer: 'Fixed it.' };
    assert.equal((verifyEngine as any).evaluateCompletionGate(turn, 'execute'), 'reject');
  });

  test('gate allows with write + green verifier when task asks for tests', () => {
    const verifyEngine = new ChatEngine({
      task: 'fix the bug and run npm test after making changes',
      projectRoot: '/tmp/test-project',
    });
    pushToolLog(verifyEngine, { tool: 'write_file', target: '/tmp/test-project/src/math.js' });
    pushToolLog(verifyEngine, { tool: 'test_run', target: 'npm test', exit_code: 0 });
    (verifyEngine as any).lastVerifierReceipt = {
      command: 'npm test',
      exit_code: 0,
      summary: 'ok',
    };
    const turn: ChatTurn = { type: 'completion', answer: 'Fixed and verified.' };
    assert.equal((verifyEngine as any).evaluateCompletionGate(turn, 'execute'), 'allow');
  });

  // Chat path logs verifiers as run_command
  test('gate allows with str_replace + run_command when task asks for tests', () => {
    const verifyEngine = new ChatEngine({
      task: 'fix the bug and run npm test after making changes',
      projectRoot: '/tmp/test-project',
    });
    pushToolLog(verifyEngine, { tool: 'str_replace', target: '/tmp/test-project/src/math.js' });
    pushToolLog(verifyEngine, { tool: 'run_command', target: 'npm test', exit_code: 0 });
    (verifyEngine as any).lastVerifierReceipt = {
      command: 'npm test',
      exit_code: 0,
      summary: 'ok',
    };
    const turn: ChatTurn = { type: 'completion', answer: 'Fixed and verified via run_command.' };
    assert.equal((verifyEngine as any).evaluateCompletionGate(turn, 'execute'), 'allow');
  });

  test('general_swe class rejects complete without green verifier', () => {
    const prev = process.env['BABEL_CHAT_TASK_CLASS'];
    process.env['BABEL_CHAT_TASK_CLASS'] = 'general_swe';
    try {
      const eng = new ChatEngine({
        task: 'fix the multi-file regression',
        projectRoot: '/tmp/test-project',
      });
      pushToolLog(eng, { tool: 'str_replace', target: '/tmp/test-project/src/a.ts' });
      const turn: ChatTurn = { type: 'completion', answer: 'Done.' };
      assert.equal((eng as any).evaluateCompletionGate(turn, 'execute'), 'reject');
      (eng as any).lastVerifierReceipt = {
        command: 'pytest -q',
        exit_code: 0,
        summary: 'ok',
      };
      assert.equal((eng as any).evaluateCompletionGate(turn, 'execute'), 'allow');
    } finally {
      if (prev === undefined) delete process.env['BABEL_CHAT_TASK_CLASS'];
      else process.env['BABEL_CHAT_TASK_CLASS'] = prev;
    }
  });

  test('governance rejects red last verifier (strict policy)', () => {
    const prev = process.env['BABEL_CHAT_TASK_CLASS'];
    process.env['BABEL_CHAT_TASK_CLASS'] = 'governance';
    try {
      const eng = new ChatEngine({
        task: 'fix the multi-file regression',
        projectRoot: '/tmp/test-project',
      });
      pushToolLog(eng, { tool: 'write_file', target: '/tmp/x.py' });
      (eng as any).lastVerifierReceipt = {
        command: 'pytest',
        exit_code: 1,
        summary: 'fail',
      };
      const turn: ChatTurn = { type: 'completion', answer: 'Ship it.' };
      assert.equal((eng as any).evaluateCompletionGate(turn, 'execute'), 'reject');
    } finally {
      if (prev === undefined) delete process.env['BABEL_CHAT_TASK_CLASS'];
      else process.env['BABEL_CHAT_TASK_CLASS'] = prev;
    }
  });
});

// ─── Gate helper method tests ────────────────────────────────────────────────

describe('Gate helpers', () => {
  // hasSubAgentWrites lives in chatEngineCriticBudget (extracted for size ratchet)
  test('hasSubAgentWrites detects "changed" in detail string', () => {
    assert.equal(
      hasSubAgentWrites([
        { tool: 'sub_agent', target: 'fix', detail: '5 steps, 3 changed' },
      ]),
      true,
    );
  });

  test('hasSubAgentWrites false when sub_agent has no changes', () => {
    assert.equal(
      hasSubAgentWrites([
        { tool: 'sub_agent', target: 'fix', detail: '5 steps, 0 changed' },
      ]),
      false,
    );
  });

  test('hasAnyWrites true with write_file', () => {
    const engine = new ChatEngine({
      task: 'fix the bug',
      projectRoot: '/tmp/test-project',
    });
    pushToolLog(engine, { tool: 'write_file', target: 'src/test.ts' });
    assert.equal((engine as any).hasAnyWrites(), true);
  });

  test('hasAnyWrites true with sub_agent writes', () => {
    const engine = new ChatEngine({
      task: 'fix the bug',
      projectRoot: '/tmp/test-project',
    });
    pushToolLog(engine, { tool: 'sub_agent', target: 'fix', detail: '2 changed' });
    assert.equal((engine as any).hasAnyWrites(), true);
  });

  test('hasAnyWrites false with only reads', () => {
    const engine = new ChatEngine({
      task: 'fix the bug',
      projectRoot: '/tmp/test-project',
    });
    pushToolLog(engine, { tool: 'read_file', target: 'src/test.ts' });
    assert.equal((engine as any).hasAnyWrites(), false);
  });

  test('buildRejectionMessage includes tool-call summary with no writes', () => {
    const engine = new ChatEngine({
      task: 'fix the bug',
      projectRoot: '/tmp/test-project',
    });
    pushToolLog(engine, { tool: 'read_file', target: 'src/a.ts' });
    pushToolLog(engine, { tool: 'grep', target: 'todo' });
    const msg = (engine as any).buildRejectionMessage();
    assert.ok(msg.includes('0 file writes'));
    assert.ok(msg.includes('0 sub-agent mutations'));
    assert.ok(msg.includes('read_file, grep'));
    assert.ok(
      msg.includes('str_replace') || msg.includes('write_file'),
      'rejection should mention str_replace or write_file',
    );
  });

  test('buildRejectionMessage with writes but no verifier', () => {
    const engine = new ChatEngine({
      task: 'fix the bug',
      projectRoot: '/tmp/test-project',
    });
    pushToolLog(engine, { tool: 'write_file', target: 'src/a.ts' });
    const msg = (engine as any).buildRejectionMessage();
    assert.ok(msg.includes('1 file writes'));
    assert.ok(msg.includes('Run the verifier'));
  });

  test('currentTurnHasMutation false when turn is all reads', () => {
    const engine = new ChatEngine({
      task: 'fix the bug',
      projectRoot: '/tmp/test-project',
    });
    (engine as any)._turnToolCallLogStart = 0;
    pushToolLog(engine, { tool: 'read_file', target: 'src/a.ts' });
    pushToolLog(engine, { tool: 'grep', target: 'pattern' });
    assert.equal((engine as any).currentTurnHasMutation(), false);
  });

  test('currentTurnHasMutation true when turn includes write_file', () => {
    const engine = new ChatEngine({
      task: 'fix the bug',
      projectRoot: '/tmp/test-project',
    });
    // Set _turnToolCallLogStart to after the read, so only the write is in "this turn"
    (engine as any)._turnToolCallLogStart = 1;
    pushToolLog(engine, { tool: 'read_file', target: 'src/a.ts' });
    pushToolLog(engine, { tool: 'write_file', target: 'src/a.ts' });
    assert.equal((engine as any).currentTurnHasMutation(), true);
  });
});

// ─── R1: BLOCKED Report Validation Tests ──────────────────────────────────────

import { validateBlockedReport as validateBlockedReportFn } from '../services/agentBenchmark.js';
import type { BlockedReport } from '../schemas/agentContracts.js';

describe('validateBlockedReport', () => {
  test('accepts report where all checked entries match tool calls', () => {
    const report: BlockedReport = {
      schema_version: 1,
      status: 'BLOCKED',
      reason: 'Source file is missing from the repository.',
      missing: 'src/format.js',
      checked: [
        { action: 'grep', target: 'format\\.js', finding: 'No matches found in repository.' },
        { action: 'read_file', target: 'src/index.js', finding: 'No import of format.js found.' },
      ],
    };
    const toolCalls = [
      { tool: 'grep', target: 'format\\.js' },
      { tool: 'read_file', target: 'src/index.js' },
      { tool: 'glob', target: '**/*.js' },
    ];
    assert.equal(validateBlockedReportFn(report, toolCalls), true);
  });

  test('rejects report where checked entry has no matching tool call', () => {
    const report: BlockedReport = {
      schema_version: 1,
      status: 'BLOCKED',
      reason: 'Cannot proceed.',
      missing: 'some-file.js',
      checked: [
        { action: 'read_file', target: 'src/fake.js', finding: 'Does not exist.' },
      ],
    };
    const toolCalls = [
      { tool: 'grep', target: 'pattern' },
    ];
    assert.equal(validateBlockedReportFn(report, toolCalls), false);
  });

  test('rejects report with mismatched tool and target', () => {
    const report: BlockedReport = {
      schema_version: 1,
      status: 'BLOCKED',
      reason: 'Cannot proceed.',
      missing: 'some-file.js',
      checked: [
        { action: 'read_file', target: 'src/exists.js', finding: 'File not found.' },
      ],
    };
    // Tool call exists but target doesn't match
    const toolCalls = [
      { tool: 'read_file', target: 'src/different.js' },
    ];
    assert.equal(validateBlockedReportFn(report, toolCalls), false);
  });

  test('accepts engine-synthesized text-only loop report', () => {
    const report: BlockedReport = {
      schema_version: 1,
      status: 'BLOCKED',
      reason: 'Agent produced only text responses without tool calls',
      missing: 'Unable to determine',
      checked: [
        {
          action: 'chat_turn',
          target: 'text_only_loop',
          finding: '5 consecutive turns with zero tool calls',
        },
      ],
    };
    assert.equal(validateBlockedReportFn(report, []), true);
  });

  test('accepts target substring match for long run_command lines', () => {
    const report: BlockedReport = {
      schema_version: 1,
      status: 'BLOCKED',
      reason: 'Binary missing',
      missing: 'babel-native-validator',
      checked: [
        {
          action: 'run_command',
          target: 'where babel-native-validator',
          finding: 'not found',
        },
      ],
    };
    const toolCalls = [
      {
        tool: 'run_command',
        target: 'cmd /c where babel-native-validator',
      },
    ];
    assert.equal(validateBlockedReportFn(report, toolCalls), true);
  });
});

// ─── R3b: Verifier Command Extraction Tests ──────────────────────────────────

describe('extractVerifierCommand', () => {
  test('extracts npm test from task', () => {
    const cmd = extractVerifierCommand('fix the bug and run npm test to verify');
    assert.equal(cmd, 'npm test');
  });

  test('extracts pytest from task', () => {
    const cmd = extractVerifierCommand('fix the Python bug. Run pytest after making changes.');
    assert.equal(cmd, 'pytest');
  });

  test('extracts npm run <script> from task', () => {
    const cmd = extractVerifierCommand('implement the feature, then execute npm run verify to check');
    assert.equal(cmd, 'npm run verify');
  });

  test('returns null when no verifier command found', () => {
    const cmd = extractVerifierCommand('explain how the router works');
    assert.equal(cmd, null);
  });

  test('extracts go test from task', () => {
    const cmd = extractVerifierCommand('run go test ./... to verify the changes');
    assert.equal(cmd, 'go test ./...');
  });
});

// ─── R3a: Post-edit static check tests ──────────────────────────────────────────

describe('post-edit static check', () => {
  test('returns null for unsupported extensions (.md, .json, .css)', async () => {
    const engine = new ChatEngine({
      task: 'fix the bug',
      projectRoot: '/tmp/test-project',
    });
    assert.equal(
      await (engine as any).runPostEditStaticCheck('/tmp/test-project/readme.md'),
      null,
    );
    assert.equal(
      await (engine as any).runPostEditStaticCheck('/tmp/test-project/config.json'),
      null,
    );
    assert.equal(
      await (engine as any).runPostEditStaticCheck('/tmp/test-project/style.css'),
      null,
    );
  });

  test('catches JavaScript syntax error via node --check', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'babel-edit-check-'));
    try {
      const badFile = join(tmpDir, 'syntax-error.js');
      writeFileSync(badFile, 'const x = ;\n');
      const engine = new ChatEngine({
        task: 'fix the bug',
        projectRoot: tmpDir,
      });
      const result = await (engine as any).runPostEditStaticCheck(badFile);
      assert.notEqual(result, null);
      assert.ok((result as string).startsWith('exit_code: 1'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('passes valid JavaScript file', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'babel-edit-check-'));
    try {
      const goodFile = join(tmpDir, 'valid.js');
      writeFileSync(goodFile, 'const x = 1;\n');
      const engine = new ChatEngine({
        task: 'fix the bug',
        projectRoot: tmpDir,
      });
      const result = await (engine as any).runPostEditStaticCheck(goodFile);
      assert.notEqual(result, null);
      assert.ok((result as string).startsWith('exit_code: 0'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('catches TypeScript syntax error when tsc is available', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'babel-edit-check-'));
    try {
      const badFile = join(tmpDir, 'syntax-error.ts');
      writeFileSync(badFile, 'const x: string = ;\n');
      // projectRoot must contain node_modules/typescript
      const engine = new ChatEngine({
        task: 'fix the bug',
        projectRoot: process.cwd(),
      });
      const result = await (engine as any).runPostEditStaticCheck(badFile);
      assert.notEqual(result, null);
      assert.ok((result as string).startsWith('exit_code: 1'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

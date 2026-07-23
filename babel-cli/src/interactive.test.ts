import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APPROVAL_READY_STATUSES,
  BabelRepl,
  classifyInteractiveTaskIntent,
  parseInteractiveDailyCommand,
} from './interactive.js';
import type { PipelineResult } from './pipeline.js';
import { renderOperatorHeader } from './ui/renderers.js';
import { stripAnsi } from './ui/theme.js';

function makeInteractiveResult(runDir: string): PipelineResult {
  const terminalSummary: NonNullable<PipelineResult['terminalSummary']> = {
    schema_version: 1,
    artifact_type: 'babel_terminal_status_summary',
    status: 'EXECUTOR_HALTED',
    reason_category: 'executor_halted',
    failed_command: null,
    changed_files: [],
    change_disposition: 'none',
    rollback_mode: 'none',
    rollback_summary_path: null,
    worktree_safety_summary_path: null,
    target_dirty_conflicts: [],
    failure_capsule_path: null,
    next_recommended_operator_action: 'Inspect run evidence.',
    parseable_json_stdout_required: true,
    attempt_safety_summary_path: null,
    repair_attempt_timeline_path: null,
    condition_summary: 'Review was cancelled before execution.',
    verifier_contract: null,
  };
  return {
    runDir,
    status: 'EXECUTOR_HALTED',
    manifest: {
      target_project: 'Babel',
      analysis: {
        task_category: 'repo_inspection',
        pipeline_mode: 'deep',
      },
      instruction_stack: {
        domain_id: 'domain_swe_backend',
        model_adapter_id: 'model_codex_balanced',
      },
      compiled_artifacts: {
        selected_entry_ids: ['behavioral_core_v7'],
        prompt_manifest: ['01_Behavioral_OS/OLS-v7-Core-Universal.md'],
      },
      prompt_manifest: ['01_Behavioral_OS/OLS-v7-Core-Universal.md'],
    } as PipelineResult['manifest'],
    plan: {
      plan_type: 'EVIDENCE_REQUEST',
      task_summary: 'Summarize repository purpose',
      minimal_action_set: [{ description: 'Read project context' }],
    } as PipelineResult['plan'],
    terminalSummary,
    usageSummary: {
      totalCostUSD: 0.001,
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalTokens: 110,
      modelBreakdown: {},
    },
  };
}

test('interactive run summary delegates to answer-first renderer for halted runs', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-interactive-summary-'));
  const repl = Object.create(BabelRepl.prototype) as {
    state: unknown;
    printRunSummary: (
      result: PipelineResult,
      context: { task: string; projectRoot?: string; transcript?: string },
    ) => void;
  };
  repl.state = {
    mode: 'deep',
    router: 'v9',
  };
  const writes: string[] = [];
  const originalLog = console.log;
  console.log = ((line?: unknown) => {
    writes.push(String(line ?? ''));
  }) as typeof console.log;
  try {
    repl.printRunSummary(makeInteractiveResult(runDir), {
      task: 'what is the repo about?',
      projectRoot: '<BABEL_REPO_ROOT>',
      transcript: '[00:00] Review passed\n[00:30] Run blocked',
    });
  } finally {
    console.log = originalLog;
    rmSync(runDir, { recursive: true, force: true });
  }

  const output = stripAnsi(writes.join('\n'));
  assert.match(output, /Babel Run Blocked/);
  assert.match(output, /Answer:\nReview was cancelled before execution\./);
  assert.match(output, /Verified:\nnot run - Review was cancelled before execution\./);
  assert.doesNotMatch(output, /Run Complete/);
  assert.doesNotMatch(output, /Orchestrator|SWE Agent|QA Reviewer|CLI Executor/);
});

test('interactive run summary writes stripped human summary artifact', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-interactive-artifact-'));
  const repl = Object.create(BabelRepl.prototype) as {
    state: unknown;
    printRunSummary: (
      result: PipelineResult,
      context: { task: string; projectRoot?: string; transcript?: string },
    ) => void;
  };
  repl.state = {
    mode: 'deep',
    router: 'v9',
  };
  const originalLog = console.log;
  console.log = (() => undefined) as typeof console.log;
  try {
    repl.printRunSummary(makeInteractiveResult(runDir), {
      task: 'what is the repo about?',
      projectRoot: '<BABEL_REPO_ROOT>',
      transcript: '[00:00] Run blocked',
    });
    const summaryPath = join(runDir, 'human_summary.txt');
    const transcriptPath = join(runDir, 'terminal_transcript.txt');
    assert.equal(existsSync(summaryPath), true);
    assert.equal(existsSync(transcriptPath), true);
    const summary = readFileSync(summaryPath, 'utf-8');
    assert.match(summary, /^Babel Run Blocked/);
    assert.doesNotMatch(summary, /\u001B\[/);
  } finally {
    console.log = originalLog;
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interactive transcript records user and assistant turns separately from command history', () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'babel-interactive-transcript-'));
  const repl = Object.create(BabelRepl.prototype) as {
    turns: unknown[];
    turnCounter: number;
    interactiveTranscriptPath: string;
    appendTurn: (turn: Record<string, unknown>) => unknown;
  };
  repl.turns = [];
  repl.turnCounter = 0;
  repl.interactiveTranscriptPath = join(sessionDir, 'transcript.jsonl');

  try {
    repl.appendTurn({ role: 'user', input: 'what is this repo about?' });
    repl.appendTurn({
      role: 'assistant',
      answer: 'It is a prompt operating system.',
      changed_files: [],
    });

    const transcript = readFileSync(repl.interactiveTranscriptPath, 'utf-8');
    assert.match(transcript, /"role":"user"/);
    assert.match(transcript, /"role":"assistant"/);
    assert.match(transcript, /prompt operating system/);
    assert.equal(repl.turns.length, 2);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('interactive follow-up prompts are resolved with previous assistant context', () => {
  const repl = Object.create(BabelRepl.prototype) as {
    lastAssistantAnswer: string | null;
    lastAssistantNext: string | null;
    lastResolvedTask: string | null;
    resolveInteractiveTask: (input: string) => string;
    classifyInteractiveLane: (input: string) => string;
  };
  repl.lastAssistantAnswer = 'The parser returns null for empty input.';
  repl.lastAssistantNext = 'Run babel "handle empty parser input".';
  repl.lastResolvedTask = 'why is the parser test failing?';

  const resolved = repl.resolveInteractiveTask('why?');
  assert.match(resolved, /Follow-up request: why\?/);
  assert.match(resolved, /Previous assistant answer:\nThe parser returns null/);
  assert.equal(repl.classifyInteractiveLane('do that'), 'fix');
});

test('interactive daily command parser recognizes bl and babel Lite verbs', () => {
  assert.deepEqual(parseInteractiveDailyCommand('bl plan a fix for our repo documentation'), {
    prefix: 'bl',
    verb: 'plan',
    task: 'a fix for our repo documentation',
  });
  assert.deepEqual(parseInteractiveDailyCommand('babel ask what is this repo about?'), {
    prefix: 'babel',
    verb: 'ask',
    task: 'what is this repo about?',
  });
  assert.equal(parseInteractiveDailyCommand('babel run "fix tests"'), null);
});

test('interactive classifier lets planning intent win over mutation nouns', () => {
  assert.equal(classifyInteractiveTaskIntent('plan a fix for our repo documentation'), 'plan');
  assert.equal(classifyInteractiveTaskIntent('design an update to the CLI'), 'plan');
  assert.equal(classifyInteractiveTaskIntent('outline a refactor for target handling'), 'plan');
  assert.equal(classifyInteractiveTaskIntent('fix the docs'), 'fix');
  assert.equal(classifyInteractiveTaskIntent('go ahead', true), 'fix');
  assert.equal(classifyInteractiveTaskIntent('y', true), 'ambiguous_confirmation');
  assert.equal(
    classifyInteractiveTaskIntent('run the full governed lane for this plan'),
    'governed',
  );
});

test('interactive classifier accepts yes after proposal or plan ready', () => {
  assert.equal(
    classifyInteractiveTaskIntent('yes', {
      hasPreviousAnswer: true,
      lastStatus: 'PLAN_READY',
    }),
    'fix',
  );
  assert.equal(
    classifyInteractiveTaskIntent('go ahead', {
      hasPreviousAnswer: true,
      lastStatus: 'PROPOSAL_READY',
    }),
    'patch',
  );
  assert.equal(
    classifyInteractiveTaskIntent('ok', {
      hasPreviousAnswer: true,
      lastStatus: 'PATCH_READY',
    }),
    'patch',
  );
  assert.ok(APPROVAL_READY_STATUSES.has('PLAN_READY'));
});

test('interactive follow-up task includes prior session tool context', () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'babel-interactive-handoff-'));
  try {
    writeFileSync(
      join(sessionDir, '04_execution_report.json'),
      JSON.stringify({
        status: 'PLAN_READY',
        tool_call_log: [{ step: 1, tool: 'read_file', target: 'src/parser.ts', exit_code: 0 }],
      }),
      'utf-8',
    );

    const repl = Object.create(BabelRepl.prototype) as {
      lastAssistantAnswer: string | null;
      lastAssistantNext: string | null;
      lastResolvedTask: string | null;
      lastSessionRunDir: string | null;
      lastRunDir: string | null;
      resolveInteractiveTask: (input: string) => string;
    };
    repl.lastAssistantAnswer = 'Start by editing src/parser.ts.';
    repl.lastAssistantNext = 'Run tests after the change.';
    repl.lastResolvedTask = 'fix the parser test';
    repl.lastSessionRunDir = sessionDir;
    repl.lastRunDir = sessionDir;

    const resolved = repl.resolveInteractiveTask('why?');
    assert.match(resolved, /Session run dir: /);
    assert.match(resolved, /read_file src\/parser\.ts/);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('interactive run summary writes deterministic output review artifact', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-interactive-review-'));
  const repl = Object.create(BabelRepl.prototype) as {
    state: unknown;
    turns: unknown[];
    turnCounter: number;
    lastAssistantAnswer: string | null;
    lastAssistantNext: string | null;
    lastResolvedTask: string | null;
    printRunSummary: (
      result: PipelineResult,
      context: { input?: string; task: string; projectRoot?: string; transcript?: string },
    ) => void;
  };
  repl.state = {
    mode: 'deep',
    router: 'v9',
  };
  repl.turns = [];
  repl.turnCounter = 0;
  repl.lastAssistantAnswer = null;
  repl.lastAssistantNext = null;
  repl.lastResolvedTask = null;
  const originalLog = console.log;
  console.log = (() => undefined) as typeof console.log;
  try {
    repl.printRunSummary(makeInteractiveResult(runDir), {
      input: 'what is the repo about?',
      task: 'what is the repo about?',
      projectRoot: '<BABEL_REPO_ROOT>',
      transcript: '[00:00] Waiting for plan approval',
    });
    const reviewPath = join(runDir, 'output_review.json');
    assert.equal(existsSync(reviewPath), true);
    const review = JSON.parse(readFileSync(reviewPath, 'utf-8')) as { artifact_type?: string };
    assert.equal(review.artifact_type, 'babel_human_output_review');
    assert.equal(repl.turns.length, 1);
  } finally {
    console.log = originalLog;
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interactive recovery commands include continue and chain', async () => {
  const { INTERACTIVE_COMMAND_GROUPS } = (await import('./interactive.js')) as {
    INTERACTIVE_COMMAND_GROUPS: ReadonlyArray<{
      title: string;
      commands: ReadonlyArray<readonly [string, string]>;
    }>;
  };
  const recovery = INTERACTIVE_COMMAND_GROUPS.find((group) => group.title === 'Recovery');
  assert.ok(recovery);
  const commands = recovery.commands.map(([command]) => command);
  assert.ok(commands.includes('/continue [run]'));
  assert.ok(commands.includes('/chain [run]'));
});

test('interactive operator header shows blocked status and deep mode after halt', () => {
  const output = stripAnsi(
    renderOperatorHeader({
      mode: 'deep',
      router: 'v9',
      lastRunUserStatus: 'blocked',
    }),
  );

  assert.match(output, /BLOCKED/);
  assert.match(output, /DEEP/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BabelRepl } from './interactive.js';
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
      target_project: 'private source repo',
      analysis: {
        task_category: 'repo_inspection',
        pipeline_mode: 'verified',
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
      minimal_action_set: [
        { description: 'Read project context' },
      ],
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
    printRunSummary: (result: PipelineResult, context: { task: string; projectRoot?: string; transcript?: string }) => void;
  };
  repl.state = {
    mode: 'verified',
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
      projectRoot: '.',
      transcript: '[00:00] Review passed\n[00:30] Run blocked',
    });
  } finally {
    console.log = originalLog;
    rmSync(runDir, { recursive: true, force: true });
  }

  const output = stripAnsi(writes.join('\n'));
  assert.match(output, /Babel Run Blocked/);
  assert.match(output, /Answer:\nReview was cancelled before execution\./);
  assert.match(output, /Changed:\nnone/);
  assert.match(output, /Verified:\nnot run - Review was cancelled before execution\./);
  assert.doesNotMatch(output, /Run Complete/);
  assert.doesNotMatch(output, /Orchestrator|SWE Agent|QA Reviewer|CLI Executor/);
});

test('interactive run summary writes stripped human summary artifact', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-interactive-artifact-'));
  const repl = Object.create(BabelRepl.prototype) as {
    state: unknown;
    printRunSummary: (result: PipelineResult, context: { task: string; projectRoot?: string; transcript?: string }) => void;
  };
  repl.state = {
    mode: 'verified',
    router: 'v9',
  };
  const originalLog = console.log;
  console.log = (() => undefined) as typeof console.log;
  try {
    repl.printRunSummary(makeInteractiveResult(runDir), {
      task: 'what is the repo about?',
      projectRoot: '.',
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
    repl.appendTurn({ role: 'assistant', answer: 'It is a prompt operating system.', changed_files: [] });

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
  repl.lastAssistantNext = 'Run bl fix "handle empty parser input".';
  repl.lastResolvedTask = 'why is the parser test failing?';

  const resolved = repl.resolveInteractiveTask('why?');
  assert.match(resolved, /Follow-up request: why\?/);
  assert.match(resolved, /Previous assistant answer:\nThe parser returns null/);
  assert.equal(repl.classifyInteractiveLane('do that'), 'fix');
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
    printRunSummary: (result: PipelineResult, context: { input?: string; task: string; projectRoot?: string; transcript?: string }) => void;
  };
  repl.state = {
    mode: 'verified',
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
      projectRoot: '.',
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

test('interactive operator header shows blocked status instead of verified after halt', () => {
  const output = stripAnsi(renderOperatorHeader({
    mode: 'verified',
    router: 'v9',
    lastRunUserStatus: 'blocked',
  }));

  assert.match(output, /BLOCKED/);
  assert.doesNotMatch(output, /VERIFIED/);
});

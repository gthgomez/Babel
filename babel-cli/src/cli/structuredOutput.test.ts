import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAskResultPayload,
  buildLiteResultPayload,
  buildRunResultPayload,
  buildHumanOutputReview,
  formatRunResultHuman,
  formatLiteResultHuman,
  makeRunStreamEvent,
  parseRunOutputFormat,
  writeHumanSummaryArtifact,
  writeProgressArtifact,
} from './structuredOutput.js';
import { stripAnsi } from '../ui/theme.js';

import type { PipelineResult } from '../pipeline.js';

function makePipelineResult(): PipelineResult {
  return {
    runDir: '<BABEL_REPO_ROOT>/runs/run-001',
    status: 'COMPLETE',
    manifest: {
      target_project: 'example_saas_backend',
      analysis: {
        task_category: 'backend',
        pipeline_mode: 'deep',
      },
      instruction_stack: {
        domain_id: 'domain_swe_backend',
        model_adapter_id: 'model_codex_balanced',
      },
      compiled_artifacts: {
        selected_entry_ids: ['behavioral_core_v7', 'domain_swe_backend'],
        prompt_manifest: ['01_Behavioral_OS/OLS-v7-Core-Universal.md'],
      },
      prompt_manifest: ['01_Behavioral_OS/OLS-v7-Core-Universal.md'],
    } as PipelineResult['manifest'],
    plan: {
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'Fix the API route',
      minimal_action_set: [{ description: 'Read the route' }, { description: 'Patch the handler' }],
    } as PipelineResult['plan'],
    usageSummary: {
      totalCostUSD: 0.0123,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
      modelBreakdown: {},
    },
  };
}

describe('parseRunOutputFormat', () => {
  it('defaults to text and lets --json override the explicit format', () => {
    assert.equal(parseRunOutputFormat(undefined, false), 'text');
    assert.equal(parseRunOutputFormat('stream-json', false), 'stream-json');
    assert.equal(parseRunOutputFormat('text', true), 'json');
  });

  it('accepts terminal and headless aliases used by agent CLIs', () => {
    assert.equal(parseRunOutputFormat('terminal', false), 'text');
    assert.equal(parseRunOutputFormat('pretty', false), 'text');
    assert.equal(parseRunOutputFormat('stream-json', false), 'stream-json');
    assert.equal(parseRunOutputFormat('jsonl', false), 'stream-json');
    assert.equal(parseRunOutputFormat('ndjson', false), 'stream-json');
  });

  it('rejects unknown formats', () => {
    assert.equal(parseRunOutputFormat('yaml', false), null);
  });
});

describe('buildRunResultPayload', () => {
  it('emits stable script-facing run metadata', () => {
    const payload = buildRunResultPayload(makePipelineResult(), {
      task: 'Fix the API route',
      mode: 'deep',
      project: 'example_saas_backend',
      requestedModel: 'deepseek',
      requestedModelTier: 'standard',
      orchestrator: 'v9',
    });

    assert.equal(payload['status'], 'COMPLETE');
    assert.equal(payload['user_status'], 'success');
    assert.equal(payload['mode'], 'deep');
    assert.equal(payload['task'], 'Fix the API route');
    assert.equal(payload['project'], 'example_saas_backend');
    assert.equal(payload['run_dir'], '<BABEL_REPO_ROOT>/runs/run-001');
    assert.deepEqual(payload['scope'], {
      project_root: null,
      allowed_write_paths: [],
      refused_paths: [],
    });
    const verification = payload['verification'] as Record<string, unknown>;
    assert.equal(verification['status'], 'not_required');
    const checkpoint = payload['checkpoint'] as Record<string, unknown>;
    assert.equal(checkpoint['required'], false);
    const evidence = payload['evidence'] as Record<string, unknown>;
    assert.equal(evidence['run_dir'], '<BABEL_REPO_ROOT>/runs/run-001');
    assert.match(
      String(
        (evidence['artifacts'] as string[]).find((artifact) =>
          artifact.endsWith('cost_ledger.json'),
        ),
      ),
      /cost_ledger\.json$/,
    );

    const routing = payload['routing'] as Record<string, unknown>;
    assert.equal(routing['orchestrator'], 'v9');
    assert.equal(routing['requested_model'], 'deepseek');
    assert.equal(routing['requested_model_tier'], 'standard');
    assert.equal(routing['domain_id'], 'domain_swe_backend');
    assert.equal(routing['prompt_manifest_count'], 1);

    const plan = payload['plan'] as Record<string, unknown>;
    assert.equal(plan['step_count'], 2);

    const usage = payload['usage'] as Record<string, unknown>;
    assert.equal(usage['totalTokens'], 150);

    const artifacts = payload['artifacts'] as Record<string, unknown>;
    assert.match(String(artifacts['terminal_status_summary']), /terminal_status_summary\.json$/);
    assert.match(String(artifacts['verifier_plan']), /verifier_plan\.json$/);
    assert.match(
      String(artifacts['verifier_execution_summary']),
      /verifier_execution_summary\.json$/,
    );
    assert.match(String(artifacts['cost_ledger']), /cost_ledger\.json$/);
    assert.equal(payload['requiredVerifierCount'], 0);
    assert.equal(payload['verifierCompletionSatisfied'], true);
  });

  it('emits terminal and attempt safety summary fields when present', () => {
    const result = makePipelineResult();
    result.terminalSummary = {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'VERIFIER_FAILED',
      reason_category: 'verifier_failure',
      failed_command: 'npm test',
      changed_files: ['src/math.js'],
      change_disposition: 'preserved_for_inspection',
      rollback_mode: 'snapshot_only',
      failure_capsule_path: 'run/12_repair_failure_capsule_attempt_1.json',
      next_recommended_operator_action: 'Inspect verifier output.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: 'run/attempt_safety_summary.json',
      repair_attempt_timeline_path: 'run/repair_attempt_timeline.json',
      condition_summary: 'test failed',
      verifier_contract: null,
    };

    const payload = buildRunResultPayload(result, {
      task: 'Fix tests',
      mode: 'deep',
    });

    const terminal = payload['terminal_status'] as Record<string, unknown>;
    assert.equal(terminal['status'], 'VERIFIER_FAILED');
    assert.equal(terminal['failed_command'], 'npm test');
  });

  it('uses governed finalAnswer as the human answer when evidence rebound finalizes read-only', () => {
    const result = makePipelineResult();
    result.status = 'READ_ONLY_NO_MODIFICATION';
    result.finalAnswer =
      'Evidence gathered and finalized without editing files.\n- Evidence gathering completed with 3 read-only evidence step(s).';

    const payload = buildRunResultPayload(result, {
      task: 'What features should we implement next?',
      mode: 'deep',
      projectRoot: '<BABEL_REPO_ROOT>',
    });
    const text = stripAnsi(formatRunResultHuman(payload));

    assert.match(text, /Babel Run Read Only No Modification/);
    assert.match(text, /Evidence gathered and finalized without editing files/);
    assert.match(text, /Evidence:\n- Run:/);
  });

  it('emits verifier contract fields when present', () => {
    const result = makePipelineResult();
    result.status = 'REQUIRED_VERIFIER_MISSING';
    result.verifierContractSummary = {
      schema_version: 1,
      artifact_type: 'babel_verifier_execution_summary',
      requiredVerifierCount: 1,
      requiredVerifierPassedCount: 0,
      requiredVerifierFailedCount: 0,
      requiredVerifierSkippedCount: 1,
      verifierCompletionSatisfied: false,
      missingRequiredVerifiers: ['npm test'],
      skippedRequiredVerifiers: [],
      failedRequiredVerifiers: [],
      completionBlockingStatus: 'REQUIRED_VERIFIER_MISSING',
      verifiers: [],
    };

    const payload = buildRunResultPayload(result, {
      task: 'Fix tests',
      mode: 'deep',
    });

    assert.equal(payload['requiredVerifierCount'], 1);
    assert.equal(payload['requiredVerifierPassedCount'], 0);
    assert.equal(payload['requiredVerifierSkippedCount'], 1);
    assert.equal(payload['verifierCompletionSatisfied'], false);
    assert.deepEqual(payload['missingRequiredVerifiers'], ['npm test']);
  });

  it('does not report user success when required verification is skipped', () => {
    const result = makePipelineResult();
    result.status = 'COMPLETE';
    result.terminalSummary = {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'REQUIRED_VERIFIER_MISSING',
      reason_category: 'verifier_contract',
      failed_command: null,
      changed_files: ['src/math.js'],
      change_disposition: 'preserved_for_inspection',
      rollback_mode: 'snapshot_only',
      failure_capsule_path: null,
      next_recommended_operator_action: 'Run required verification.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: 'required verifier missing',
      verifier_contract: null,
    };
    result.verifierContractSummary = {
      schema_version: 1,
      artifact_type: 'babel_verifier_execution_summary',
      requiredVerifierCount: 1,
      requiredVerifierPassedCount: 0,
      requiredVerifierFailedCount: 0,
      requiredVerifierSkippedCount: 1,
      verifierCompletionSatisfied: false,
      missingRequiredVerifiers: ['npm test'],
      skippedRequiredVerifiers: ['npm test'],
      failedRequiredVerifiers: [],
      completionBlockingStatus: 'REQUIRED_VERIFIER_MISSING',
      verifiers: [],
    };

    const payload = buildRunResultPayload(result, {
      task: 'Fix tests',
      mode: 'deep',
    });

    assert.equal(payload['user_status'], 'not_verified');
    assert.deepEqual(payload['changed_files'], ['src/math.js']);
    const verification = payload['verification'] as Record<string, unknown>;
    assert.equal(verification['status'], 'skipped');
    const checkpoint = payload['checkpoint'] as Record<string, unknown>;
    assert.equal(checkpoint['required'], true);
    assert.match(String(checkpoint['inspect_command']), /babel checkpoint list/);
    const artifacts = payload['artifacts'] as Record<string, unknown>;
    assert.match(String(artifacts['cost_ledger']), /cost_ledger\.json$/);
  });
});

describe('Babel Lite result output', () => {
  it('renders manual planning as a concise Lite plan instead of Manual Bridge JSON', () => {
    const result = makePipelineResult();
    result.status = 'MANUAL_BRIDGE_REQUIRED';
    result.manualPromptPath = '<BABEL_REPO_ROOT>/runs/run-001/02_manual_prompt.md';

    const payload = buildLiteResultPayload(result, {
      verb: 'plan',
      task: 'split Babel and Lite output',
      mode: 'plan',
      project: 'example_saas_backend',
    });

    assert.equal(payload.status, 'PLAN_READY');
    assert.equal(payload.user_status, 'success');
    assert.equal(payload.lite_command, 'plan');
    assert.equal(payload.scope.allowed_write_paths.length, 0);
    assert.equal(payload.verification.status, 'not_required');
    assert.match(payload.next.join('\n'), /babel "split Babel and Lite output"/);

    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /^Babel Plan Ready/);
    assert.match(human, /\nAnswer:\nPrepared a plan artifact/);
    assert.match(human, /\nEvidence:\n- Run:/);
    assert.doesNotMatch(human, /MANUAL_BRIDGE_REQUIRED/);
    assert.doesNotMatch(human, /Manual Bridge/);
  });

  it('keeps fix visible instead of reporting patch in Lite output', () => {
    const result = makePipelineResult();
    const payload = buildLiteResultPayload(result, {
      verb: 'fix',
      task: 'fix the parser test',
      mode: 'deep',
      project: 'example_saas_backend',
    });

    assert.equal(payload.status, 'FIX_COMPLETE');
    assert.equal(payload.user_status, 'success');
    assert.equal(payload.lite_command, 'fix');
    assert.equal(payload.details.full_babel_equivalent, 'babel "fix the parser test"');

    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /^Babel Fix Complete/);
    assert.doesNotMatch(human, /Babel Proposal only/);
  });

  it('renders patch as proposal-only manual output', () => {
    const result = makePipelineResult();
    result.status = 'MANUAL_BRIDGE_REQUIRED';
    result.manualPromptPath = '<BABEL_REPO_ROOT>/runs/run-001/02_manual_prompt.md';
    const payload = buildLiteResultPayload(result, {
      verb: 'patch',
      task: 'propose the Lite help diff',
      mode: 'plan',
      project: 'example_saas_backend',
    });

    assert.equal(payload.status, 'PATCH_READY');
    assert.equal(payload.user_status, 'success');
    assert.equal(payload.lite_command, 'patch');
    assert.deepEqual(payload.changed_files, []);
    assert.equal(payload.verification.status, 'not_required');
    assert.match(payload.next.join('\n'), /proposal artifact/i);
    assert.equal(payload.details.full_babel_equivalent, 'babel plan "propose the Lite help diff"');

    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /^Babel (?:Patch|Proposal only) Ready/);
    assert.match(human, /No source files were changed|proposal/i);
    assert.match(human, /\nEvidence:\n- Run:/);
  });

  it('renders do as a daily work lane with its own status', () => {
    const result = makePipelineResult();
    const payload = buildLiteResultPayload(result, {
      verb: 'do',
      task: 'fix the parser test',
      mode: 'deep',
      project: 'example_saas_backend',
      selectedLane: 'fix',
    });

    assert.equal(payload.status, 'DO_COMPLETE');
    assert.equal(payload.lite_command, 'do');
    assert.equal(payload.selected_lane, 'fix');
    assert.match(payload.details.full_babel_equivalent, /^babel "/);

    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /^Babel Scoped fix Complete/);
    assert.match(human, /\nMode:\nScoped fix/);
  });

  it('adds route metadata to do payloads for visibility in CLI output', () => {
    const result = makePipelineResult();
    const payload = buildLiteResultPayload(result, {
      verb: 'do',
      task: 'Harden migration plan with Spark agents',
      mode: 'deep',
      project: 'example_saas_backend',
      selectedLane: 'patch',
      routeDecision: {
        route_reason: 'Requested explicit full-lane hardening.',
        complexity: 'high',
        risk_signals: [
          { code: 'repo_wide_or_architecture', reason: 'Repository-wide scope' },
          { code: 'explicit_full_or_agents', reason: 'Explicit full lane request' },
        ],
        model_tier_recommendation: 'escalation',
        full_babel_equivalent: 'babel deep "Harden migration plan with Spark agents"',
      },
    });

    assert.equal(payload.route_reason, 'Requested explicit full-lane hardening.');
    assert.equal(payload.complexity, 'high');
    assert.equal(payload.model_tier_recommendation, 'escalation');
    assert.equal(payload.risk_signals?.length, 2);
    assert.equal(
      payload.full_babel_equivalent,
      'babel deep "Harden migration plan with Spark agents"',
    );

    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /^Babel Proposal only Complete/);
    assert.match(human, /\nMode:\nProposal only/);
    assert.doesNotMatch(human, /route_reason|model_tier_recommendation|risk_signals/);
  });

  it('reports do-selected patch lane separately from planning', () => {
    const result = makePipelineResult();
    result.status = 'MANUAL_BRIDGE_REQUIRED';
    const payload = buildLiteResultPayload(result, {
      verb: 'do',
      selectedLane: 'patch',
      task: 'propose a patch for the parser test',
      mode: 'plan',
      project: 'example_saas_backend',
    });

    assert.equal(payload.lite_command, 'do');
    assert.equal(payload.selected_lane, 'patch');
    assert.equal(payload.status, 'PATCH_READY');

    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /^Babel Proposal only Ready/);
    assert.match(human, /\nMode:\nProposal only/);
  });

  it('includes usage and read-only answer fields for Lite ask', () => {
    const result = makePipelineResult();
    result.status = 'COMPLETE_NO_MODIFICATION';
    const payload = buildLiteResultPayload(result, {
      verb: 'ask',
      task: 'why is this failing?',
      mode: 'chat',
      project: 'example_saas_backend',
    });

    assert.equal(payload.status, 'ANSWER_READY');
    assert.equal(payload.user_status, 'success');
    assert.equal(payload.usage.totalTokens, 150);
    assert.equal(payload.answer?.summary, 'Fix the API route');
    assert.deepEqual(payload.scope.allowed_write_paths, []);
    assert.equal(payload.checkpoint.required, false);
    assert.match(
      String(payload.evidence.artifacts.find((artifact) => artifact.endsWith('cost_ledger.json'))),
      /cost_ledger\.json$/,
    );
    assert.equal(payload.details.full_babel_equivalent, 'babel "why is this failing?"');

    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /^Babel Ask Ready/);
    assert.match(human, /Answer:/);
    assert.match(human, /Fix the API route/);
    assert.match(human, /Run: .* — 150 tokens, \$0\.012300/);
  });

  it('adds cost ledger path to Lite usage and human output when present', () => {
    const result = makePipelineResult();
    result.runDir = mkdtempSync(join(tmpdir(), 'babel-usage-cost-ledger-'));
    mkdirSync(result.runDir, { recursive: true });
    writeFileSync(
      join(result.runDir, 'cost_ledger.json'),
      JSON.stringify({ artifact_type: 'babel_cost_ledger' }),
      'utf8',
    );
    const payload = buildLiteResultPayload(result, {
      verb: 'fix',
      task: 'fix the parser test',
      mode: 'deep',
      project: 'example_saas_backend',
    });

    assert.equal(payload.usage.cost_ledger_path, join(result.runDir, 'cost_ledger.json'));
    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /150 tokens, \$0\.012300/);
    assert.doesNotMatch(human, /Cost ledger:/);
  });

  it('keeps diagnostic retry language out of normal Lite copy', () => {
    const result = makePipelineResult();
    const payload = buildLiteResultPayload(result, {
      verb: 'do',
      task: 'fix the parser test',
      mode: 'deep',
      project: 'example_saas_backend',
    });
    payload.schema_retries = 2;
    payload.recovered_after_schema_retry = true;

    const human = stripAnsi(formatLiteResultHuman(payload));
    assert.match(human, /^Babel Scoped fix Complete/);
    // SKIP: retry diagnostic is hidden from user output for ≤3 retries
    assert.doesNotMatch(human, /selected_lane|schema_retries|support_path/);
  });

  it('caps changed files and keeps absolute paths under Evidence', () => {
    const projectRoot = '/tmp/workspace';
    const payload = buildRunResultPayload(makePipelineResult(), {
      task: 'touch many files',
      mode: 'deep',
      projectRoot,
    });
    payload['changed_files'] = Array.from(
      { length: 10 },
      (_, index) => `${projectRoot}/src/file-${index}.ts`,
    );
    const human = stripAnsi(formatRunResultHuman(payload));
    // Changed section ends before Evidence (no Verified section when not needed)
    const changedSection =
      human.match(/\nChanged:\n(?<section>[\s\S]*?)\n\nEvidence:/)?.groups?.['section'] ?? '';

    assert.match(changedSection, /- src\/file-0\.ts/);
    assert.match(changedSection, /\+2 more/);
    assert.doesNotMatch(changedSection, /\/tmp\/workspace/);
    assert.match(human, /Evidence:\n- Run: .+runs\/run-001/);
  });

  it('collapses nested cost ledger lines into the run evidence line', () => {
    const runDir = '<BABEL_REPO_ROOT>/runs/run-001';
    const payload = buildRunResultPayload(makePipelineResult(), {
      task: 'fix the parser test',
      mode: 'deep',
      project: 'example_saas_backend',
    });
    payload['status'] = 'FIX_COMPLETE';
    payload['lite_command'] = 'fix';
    payload['run_dir'] = runDir;
    payload['usage'] = {
      totalCostUSD: 0.001024,
      totalInputTokens: 900,
      totalOutputTokens: 426,
      totalTokens: 1326,
      modelBreakdown: {},
      cost_ledger_path: `${runDir}/cost_ledger.json`,
    };

    const human = stripAnsi(formatRunResultHuman(payload));
    assert.match(human, /Evidence:\n- Run: .* — 1,326 tokens, \$0\.001024/);
    assert.doesNotMatch(human, /Cost ledger:/);
  });

  it('renders ask targets before answers without changing machine payload fields', () => {
    const payload = buildRunResultPayload(makePipelineResult(), {
      task: 'what is this repo about?',
      mode: 'chat',
      projectRoot: '<BABEL_REPO_ROOT>',
    });
    payload['status'] = 'ANSWER_READY';
    payload['command'] = 'ask';
    payload['answer'] = {
      status: 'ANSWER_READY',
      summary: 'Babel is a prompt operating system.',
      answer: 'Babel is a prompt operating system for assembling agent instruction stacks.',
      facts: [],
      assumptions: [],
      evidence: [],
      next: ['Inspect PROJECT_CONTEXT.md for more detail.'],
    };

    const human = stripAnsi(formatRunResultHuman(payload));
    assert.match(
      human,
      /^Babel Ask Ready\n\nTarget:\n\/tmp\/babel-repo\n\nAnswer:\nBabel is a prompt operating system/,
    );
    assert.deepEqual(payload['scope'], {
      project_root: '<BABEL_REPO_ROOT>',
      allowed_write_paths: [],
      refused_paths: [],
    });
  });

  it('renders simple read-only run answers without executor language', () => {
    const payload = buildAskResultPayload({
      answer: {
        schema_version: 1,
        status: 'ANSWER_READY',
        summary: 'Babel is a prompt operating system.',
        answer: 'Babel is a prompt operating system for assembling agent instruction stacks.',
        facts: [],
        assumptions: [],
        evidence: [],
        next: ['Inspect PROJECT_CONTEXT.md for more detail.'],
      },
      task: 'what is this repo about?',
      projectRoot: '<BABEL_REPO_ROOT>',
      runDir: '<BABEL_REPO_ROOT>/runs/babel-lite/run-ask',
    }) as unknown as Record<string, unknown>;
    payload['command'] = 'run';
    payload['mode'] = 'chat';
    payload['tool_policy'] = {
      allowed_tools: ['directory_list', 'file_read'],
      disallowed_tools: [],
    };

    const human = stripAnsi(formatRunResultHuman(payload));

    assert.equal(payload['status'], 'ANSWER_READY');
    assert.equal(payload['command'], 'run');
    assert.match(human, /^Babel Run Ready/);
    assert.match(human, /Evidence:\n- Run:/);
    assert.doesNotMatch(human, /Executor turn|Stage 4|CLI Executor|QA Reviewer/);
  });

  it('renders failed and blocked runs without success wording', () => {
    const payload = buildRunResultPayload(makePipelineResult(), {
      task: 'fix tests',
      mode: 'deep',
    });
    payload['status'] = 'EXECUTOR_HALTED';
    payload['user_status'] = 'failed';
    payload['errors'] = ['QA rejected the plan'];
    payload['verification'] = {
      status: 'failed',
      commands: ['npm test: failed'],
      skipped_reason: null,
    };
    const human = stripAnsi(formatRunResultHuman(payload));

    assert.match(human, /^Babel Run Blocked/);
    assert.match(human, /Why:\n- QA rejected the plan/);
    assert.match(human, /Verified:\n- npm test: failed/);
    assert.doesNotMatch(human, /Complete/);
  });

  it('renders executor halted as blocked even without caller-provided user_status', () => {
    const result = makePipelineResult();
    result.status = 'EXECUTOR_HALTED';
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
    result.terminalSummary = terminalSummary;
    const payload = buildRunResultPayload(result, {
      task: 'what is the repo about?',
      mode: 'deep',
    });
    delete payload['user_status'];

    const human = stripAnsi(formatRunResultHuman(payload));
    assert.match(human, /^Babel Run Blocked/);
    assert.match(human, /Answer:\nReview was cancelled before execution\./);
    assert.match(human, /Evidence:\n- Run:/);
    assert.doesNotMatch(human, /^Babel Run Complete/);
    assert.doesNotMatch(human, /Run Complete/);
  });

  it('cleans objective and internal labels from answer summaries', () => {
    const payload = buildRunResultPayload(makePipelineResult(), {
      task: 'summarize repo',
      mode: 'plan',
    });
    payload['status'] = 'PLAN_READY';
    payload['command'] = 'plan';
    payload['plan'] = {
      task_summary: 'OBJECTIVE: QA Reviewer Stage 3 / 4 summarize the repo purpose.',
    };

    const human = stripAnsi(formatRunResultHuman(payload));
    assert.match(human, /Answer:\nsummarize the repo purpose\./);
    assert.match(human, /Evidence:\n- Run:/);
    assert.doesNotMatch(human, /OBJECTIVE|QA Reviewer|Stage 3 \/ 4/);
  });

  it('does not present directive-like run summaries as conversational answers', () => {
    const payload = buildRunResultPayload(makePipelineResult(), {
      task: 'what is this repo about?',
      mode: 'chat',
    });
    payload['plan'] = {
      task_summary:
        'OBJECTIVE: Analyze repository structure and documentation to determine project scope.',
    };
    payload['verification'] = { status: 'not_required', commands: [], skipped_reason: null };
    payload['changed_files'] = [];

    const human = stripAnsi(formatRunResultHuman(payload));
    assert.match(human, /Answer:\nCompleted a read-only run without changing source files/);
    assert.doesNotMatch(human, /Answer:\nAnalyze repository/);
  });

  it('writes human summary, stripped transcript, and deterministic output review artifacts', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-output-review-'));
    const summaryTarget = process.cwd().replace(/\\/g, '/');
    const summary = [
      'Babel Run Complete',
      '',
      'Target:',
      summaryTarget,
      '',
      'Answer:',
      'Completed the run.',
      '',
      'Changed:',
      'none',
      '',
      'Verified:',
      'not required - read-only request',
      '',
      'Evidence:',
      `- Run: ${summaryTarget}/runs/example`,
      '',
      'Next:',
      'Review the run evidence.',
    ].join('\n');

    writeHumanSummaryArtifact(runDir, summary, '\u001B[31m[00:00] Routing request\u001B[0m');

    assert.equal(existsSync(join(runDir, 'human_summary.txt')), true);
    assert.equal(existsSync(join(runDir, 'terminal_transcript.txt')), true);
    assert.equal(existsSync(join(runDir, 'output_review.json')), true);
    assert.equal(existsSync(join(runDir, 'progress.jsonl')), true);
    assert.doesNotMatch(readFileSync(join(runDir, 'terminal_transcript.txt'), 'utf-8'), /\u001B\[/);
    const progress = JSON.parse(
      readFileSync(join(runDir, 'progress.jsonl'), 'utf-8').trim(),
    ) as Record<string, unknown>;
    assert.equal(progress['type'], 'progress');
    assert.equal(progress['message'], 'Routing request');
    assert.equal(progress['elapsed'], '00:00');
    const review = JSON.parse(
      readFileSync(join(runDir, 'output_review.json'), 'utf-8'),
    ) as ReturnType<typeof buildHumanOutputReview>;
    assert.equal(review.status, 'pass');
  });

  it('writes fallback progress events when no transcript is available', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-progress-artifact-'));

    writeProgressArtifact(runDir, null, 'Babel Plan Ready');

    const progress = JSON.parse(
      readFileSync(join(runDir, 'progress.jsonl'), 'utf-8').trim(),
    ) as Record<string, unknown>;
    assert.equal(progress['type'], 'progress');
    assert.equal(progress['message'], 'Babel Plan Ready');
  });

  it('output review flags internal language and contradictory completion wording', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Run Complete',
        '',
        'Answer:',
        'EXECUTOR_HALTED after QA Reviewer blocked the task.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not run - blocked',
        '',
        'Evidence:',
        '- Run: C:/run',
        '',
        'Next:',
        'Inspect evidence.',
      ].join('\n'),
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some((check) => check.id === 'internal_language' && check.status === 'fail'),
      true,
    );
    assert.equal(
      review.checks.some((check) => check.id === 'status_accuracy' && check.status === 'fail'),
      true,
    );
  });

  it('output review flags unsupported absence claims that contradict the target path', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Ask Ready',
        '',
        'Target:',
        '/tmp/example_game_suite/relicRun',
        '',
        'Answer:',
        'relicRun is not recognized in this workspace.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not required - read-only request',
        '',
        'Evidence:',
        '- Run: <BABEL_REPO_ROOT>/runs/example',
        '',
        'Next:',
        'Inspect the target README.',
      ].join('\n'),
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some(
        (check) => check.id === 'unsupported_absence_claim' && check.status === 'fail',
      ),
      true,
    );
  });

  it('output review fails when summary and manifest targets differ', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Ask Ready',
        '',
        'Target:',
        '/tmp/example_game_suite/relicRun',
        '',
        'Answer:',
        'This repo contains a game prototype.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not required - read-only request',
        '',
        'Evidence:',
        '- Run: C:/run',
        '',
        'Next:',
        'Review evidence.',
      ].join('\n'),
      '',
      {
        expectedTargetRoot: '/tmp/example_game_suite/relicRun',
        manifestTargetRoot: '/tmp/example_game_suite',
      },
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some((check) => check.id === 'target_consistency' && check.status === 'fail'),
      true,
    );
  });

  it('output review fails when executed absolute tool target is outside disclosed target', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Run Complete',
        '',
        'Target:',
        '/tmp/workspace/project',
        '',
        'Answer:',
        'Completed the run.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not required - read-only request',
        '',
        'Evidence:',
        '- Run: /tmp/workspace/runs/example',
        '',
        'Next:',
        'Review evidence.',
      ].join('\n'),
      '',
      {
        expectedTargetRoot: '/tmp/workspace/project',
        executedTargets: ['/tmp/other/path/package.json'],
      },
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some((check) => check.id === 'tool_target_scope' && check.status === 'fail'),
      true,
    );
  });

  it('output review resolves relative executed tool targets against disclosed target', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Run Complete',
        '',
        'Target:',
        '/tmp/example_game_suite/relicRun',
        '',
        'Answer:',
        'Completed the run.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not required - read-only request',
        '',
        'Evidence:',
        '- Run: C:/run',
        '',
        'Next:',
        'Review evidence.',
      ].join('\n'),
      '',
      {
        expectedTargetRoot: '/tmp/example_game_suite/relicRun',
        executedTargets: ['..\\README.md'],
      },
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some((check) => check.id === 'tool_target_scope' && check.status === 'fail'),
      true,
    );
  });

  it('output review fails when blocked summary is paired with verified badge', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Run Blocked',
        '',
        'Answer:',
        'The run was blocked.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not run - blocked',
        '',
        'Evidence:',
        '- Run: C:/run',
        '',
        'Next:',
        'Inspect evidence.',
      ].join('\n'),
      '',
      {
        terminalStatus: 'EXECUTOR_HALTED',
        shellBadge: '[VERIFIED]',
      },
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some(
        (check) => check.id === 'blocked_badge_accuracy' && check.status === 'fail',
      ),
      true,
    );
  });

  it('output review fails when report intent only promises future analysis', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Report Ready',
        '',
        'Target:',
        '<BABEL_REPO_ROOT>',
        '',
        'Answer:',
        'We will inspect the CLI and produce a written comparison report.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not required - read-only report',
        '',
        'Evidence:',
        '- Run: <BABEL_REPO_ROOT>/runs/babel-lite/report-001',
        '',
        'Next:',
        'Produce a report.',
      ].join('\n'),
      '',
      {
        expectedTargetRoot: '<BABEL_REPO_ROOT>',
        manifestTargetRoot: '<BABEL_REPO_ROOT>',
        task: 'compare implementation paths for target drift and latest pointers',
        runStatus: 'REPORT_READY',
      },
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some((check) => check.id === 'intent_fulfillment' && check.status === 'fail'),
      true,
    );
  });

  it('output review fails shallow reports with only process bookkeeping', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Report Ready',
        '',
        'Target:',
        '<BABEL_REPO_ROOT>',
        '',
        'Answer:',
        'Completed a local read-only report. The available contract points to src/output.ts as the first area to inspect, and no source files were changed.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not required - read-only report',
        '',
        'Evidence:',
        '- Run: <BABEL_REPO_ROOT>/runs/babel-lite/report-001',
        '',
        'Next:',
        'Review report.md in the artifact directory.',
      ].join('\n'),
      '',
      {
        expectedTargetRoot: '<BABEL_REPO_ROOT>',
        manifestTargetRoot: '<BABEL_REPO_ROOT>',
        task: 'compare concise terminal output choices',
        runStatus: 'REPORT_READY',
      },
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some((check) => check.id === 'report_depth' && check.status === 'fail'),
      true,
    );
  });

  it('output review fails compare reports without comparison or tradeoff language', () => {
    const review = buildHumanOutputReview(
      [
        'Babel Report Ready',
        '',
        'Target:',
        '<BABEL_REPO_ROOT>',
        '',
        'Answer:',
        'The evidence shows src/output.ts is relevant to the task.',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not required - read-only report',
        '',
        'Evidence:',
        '- Run: <BABEL_REPO_ROOT>/runs/babel-lite/report-001',
        '',
        'Next:',
        'Review evidence.',
      ].join('\n'),
      '',
      {
        task: 'compare concise terminal output choices',
        runStatus: 'REPORT_READY',
      },
    );

    assert.equal(review.status, 'needs_attention');
    assert.equal(
      review.checks.some((check) => check.id === 'report_depth' && check.status === 'fail'),
      true,
    );
  });

  it('output review passes evidence-backed compare reports with suggested verification language', () => {
    const reviewTargetRoot = process.cwd();
    const review = buildHumanOutputReview(
      [
        'Babel Report Ready',
        '',
        'Target:',
        reviewTargetRoot,
        '',
        'Answer:',
        'The evidence shows terminal output and progress artifacts are distinct options to compare: terminal output optimizes human scanning, while progress artifacts support scripting and replay.',
        '',
        'Findings:',
        '- Compared direct evidence against adjacent context: likely files are src/output.ts, while suspected files are src/progress.ts.',
        '- Compared risk and verification tradeoffs: the contract classifies this as Review because CLI output is shared; suggested checks are npm test.',
        '',
        'Suggested verification:',
        '- npm test',
        '',
        'Changed:',
        'none',
        '',
        'Verified:',
        'not required - read-only report',
        '',
        'Evidence:',
        `- Run: ${reviewTargetRoot}/runs/babel-lite/report-001`,
        '',
        'Next:',
        'Review evidence.',
      ].join('\n'),
      '',
      {
        expectedTargetRoot: reviewTargetRoot,
        manifestTargetRoot: reviewTargetRoot,
        task: 'compare concise terminal output choices',
        runStatus: 'REPORT_READY',
      },
    );

    assert.equal(review.status, 'pass');
    assert.equal(
      review.checks.some((check) => check.id === 'report_depth' && check.status === 'pass'),
      true,
    );
  });
});

describe('makeRunStreamEvent', () => {
  it('adds timestamps without dropping event fields', () => {
    const event = makeRunStreamEvent('stage', {
      stage_index: 2,
      stage_name: 'planner',
    });

    assert.equal(event.type, 'stage');
    assert.equal(event.stage_index, 2);
    assert.equal(event.stage_name, 'planner');
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries runtime protocol events for stream-json consumers', () => {
    const event = makeRunStreamEvent('runtime_event', {
      runtime_event: {
        protocol_version: 1,
        event_type: 'policy.decision',
        payload: { decision: 'allow' },
      },
    });

    assert.equal(event.type, 'runtime_event');
    assert.equal(event.runtime_event?.event_type, 'policy.decision');
  });

  it('suppresses broken stdout pipe errors for NDJSON writers', () => {
    const script = `
      import { writeNdjson, makeRunStreamEvent } from './src/cli/structuredOutput.ts';
      writeNdjson(makeRunStreamEvent('log', { line: 'first' }));
      process.stdout.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }));
      writeNdjson(makeRunStreamEvent('log', { line: 'second' }));
      process.stderr.write('BROKEN_PIPE_NDJSON_OK');
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15_000,
    });

    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /BROKEN_PIPE_NDJSON_OK/);
  });
});

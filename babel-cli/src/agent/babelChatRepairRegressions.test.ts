import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProjectRoot } from '../cli/helpers.js';
import { resolveAgentTarget } from '../services/targetResolver.js';
import { gitContext, handleGitContextTool } from '../tools/gitContext.js';
import { getGitInfo } from '../ui/gitInfo.js';
import { RevisionManager } from '../evidence/revisionBoundReceipt.js';
import {
  ChatEngineP11Authority,
  type ChatEngineP11Host,
} from './chatEngineP11Authority.js';
import { runChatEngineCompaction, type ChatEngineCompactionHost } from './compactionCommit.js';
import { createThreadEventLog } from './threadEventLog.js';
import {
  appendSessionEvent,
  createSessionEventLog,
  recordToolProposed,
  recordToolTerminal,
  recordTurnEnded,
  recordUserSubmitted,
  rewriteSessionEventLog,
} from './sessionEvents.js';
import { executeReadRangeAction } from './codingLoop/readRangeExecutor.js';
import { createWorkingState } from './codingLoop/workingState.js';
import { validateSessionRun } from './sessionRunValidator.js';
import { CompactionManager } from './chatCompaction.js';
import { renderStatusBar } from '../ui/statusBar.js';
import { buildReviewCard } from '../ui/reviewCard.js';
import { projectTurnViewState } from '../interactive/projection/turnViewProjector.js';
import {
  terminalReasonFromFailureText,
  terminalReasonGuidance,
} from './chatTerminalReason.js';
import { outcomeFromReasonCode } from './chatEngineObservability.js';
import { buildCausalAttributionReport } from '../services/causalAttribution.js';
import { ConversationalRenderer } from '../ui/conversationalRenderer.js';
import { OutputBuffer } from '../ui/outputBuffer.js';
import { renderErrorBox } from '../ui/rendererSupport.js';
import { formatConversationThinkingStatus } from '../ui/conversationLiveness.js';
import { stripAnsi, visibleLength } from '../ui/theme.js';

function initGitRepo(dir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), `# ${branch}\n`, 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

describe('Boundary 1: Umbrella target resolution, nested git_context, and target-aware gitInfo', () => {
  it('resolves active catalog child project over sibling verify worktrees inside an umbrella workspace', async () => {
    const umbrella = mkdtempSync(join(tmpdir(), 'babel-umbrella-'));
    try {
      mkdirSync(join(umbrella, 'config'), { recursive: true });
      writeFileSync(join(umbrella, 'AGENTS.md'), '# Umbrella Workspace\n', 'utf8');
      const activeDir = join(umbrella, 'Project_Apps', 'Prismatix', 'Prismatix');
      const verifyDir = join(umbrella, 'Project_Apps', 'Prismatix', 'Prismatix-verify');
      mkdirSync(activeDir, { recursive: true });
      mkdirSync(verifyDir, { recursive: true });
      initGitRepo(activeDir, 'main');
      initGitRepo(verifyDir, 'verify-branch');

      writeFileSync(
        join(umbrella, 'config', 'workspace-products.json'),
        JSON.stringify({
          products: [
            {
              id: 'prismatix-verify',
              name: 'Prismatix-verify',
              path: 'Project_Apps/Prismatix/Prismatix-verify',
              lifecycle: 'archive',
            },
            {
              id: 'prismatix',
              name: 'Prismatix',
              path: 'Project_Apps/Prismatix/Prismatix',
              lifecycle: 'active',
            },
          ],
        }),
        'utf8',
      );

      const resolvedByFlag = resolveProjectRoot('Prismatix', umbrella);
      assert.equal(resolvedByFlag, activeDir);

      const resolvedByTask = resolveAgentTarget({
        cwd: umbrella,
        task: 'research my current Prismatix repo and recommend UI fixes and improvements after running a critique pass.',
      });
      assert.equal(resolvedByTask.targetRoot, activeDir);
      assert.equal(resolvedByTask.source, 'named_project');

      const gitCtx = gitContext(umbrella, { path: 'Project_Apps/Prismatix/Prismatix' });
      assert.equal(gitCtx.inRepo, true);
      assert.equal(gitCtx.branch, 'main');

      const toolOut = await handleGitContextTool(
        { path: 'Project_Apps/Prismatix/Prismatix', output_format: 'json' },
        umbrella,
      );
      assert.equal(toolOut.exit_code, 0);
      assert.deepEqual(JSON.parse(toolOut.stdout), {
        branch: 'main',
        inRepo: true,
        files: [],
        diffStat: '',
        diffTruncated: false,
      });

      const umbrellaInfo = getGitInfo(umbrella);
      const childInfo = getGitInfo(activeDir);
      assert.equal(umbrellaInfo.branch, null);
      assert.equal(childInfo.branch, 'main');
    } finally {
      rmSync(umbrella, { recursive: true, force: true });
    }
  });
});

describe('Boundary 2: Physical capture refusal propagation and Compaction P11 readiness gate', () => {
  it('propagates physical capture refusal reason into P11 sources_unavailable diagnostic and blocks compaction before LLM call', async () => {
    const nonGitRoot = mkdtempSync(join(tmpdir(), 'babel-p11-umbrella-'));
    try {
      initGitRepo(nonGitRoot, 'main');
      // Write a >1MB file so physical revision capture refuses with closure size cap
      writeFileSync(join(nonGitRoot, 'app-release.apk'), Buffer.alloc(1_100_000, 0x61));

      const rev = RevisionManager.computeRevisionSync(nonGitRoot, [], {
        scope_kind: 'repository',
        git_binding: 'optional',
      });
      assert.equal(rev.gitCommitHash, null);
      assert.match(String(rev.captureFailureReason ?? ''), /Input file exceeds the closure size cap/);

      const threadLog = createThreadEventLog('sess-test');
      const sessionLog = createSessionEventLog('sess-test');
      const host = {
        options: {
          projectRoot: nonGitRoot,
          task: 'inspect repo',
        },
        changedFiles: new Set<string>(),
        parity: {
          liveAuthority: { taskContract: { goal: 'inspect repo', acceptance: [], contract_hash: 'h' } },
          admissionStore: null,
          sessionEvents: sessionLog,
        },
        taskAllowance: {
          taskOwnerId: 'owner-1',
          grant: { turnCap: 10 },
          consumed: { turns: 1 },
        },
        p11InstallBlock: null as { code: string; details: string[] } | null,
        shouldUseTextTools: () => false,
        buildP11Sources: () => null,
      } as unknown as ChatEngineP11Host;

      const authority = new ChatEngineP11Authority(host);
      const route = {
        compiled_request_identity: 'req-1',
        tool_profile: 'native-tools',
        model_route: 'openrouter:deepseek/deepseek-v4-flash-0731',
      };
      const sources = authority.buildP11Sources(route);
      assert.equal(sources, null);

      let compactionLlmCalled = false;
      let blockedCallbackFired = false;
      const compactionHost: ChatEngineCompactionHost = {
        conversation: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'u1'.repeat(500) },
          { role: 'assistant', content: 'a1'.repeat(500) },
          { role: 'user', content: 'u2'.repeat(500) },
          { role: 'assistant', content: 'a2'.repeat(500) },
        ],
        compactionManager: {
          async compactWithResult() {
            compactionLlmCalled = true;
            throw new Error('should not be called when canCommitCompactionCapsule is false');
          },
        },
        options: { task: 'inspect repo', model: 'deepseek/deepseek-v4-flash-0731' },
        modelPolicy: null,
        limits: { maxEstimatedTokens: 100 },
        abortSignal: new AbortController().signal,
        writeCount: 0,
        turnIndex: 1,
        toolCallLog: [],
        progress: { receipts: [], consecutiveNoProgress: 0 },
        threadLog,
        sessionLog,
        turnId: 'turn-1',
        shouldUseTextTools: () => false,
        compactHeuristic: () => {
          compactionLlmCalled = true;
        },
        checkpoint: async () => {},
        reserveTokens: 10,
        textToolsReserve: 0,
        resolveModel: () => 'deepseek/deepseek-v4-flash-0731',
        shouldCompactByTokens: () => true,
        estimateTokens: () => 5000,
        forceCompaction: true,
        canCommitCompactionCapsule: () => authority.buildP11Sources(route) !== null,
        onCompactionBlockedByAuthority: () => {
          blockedCallbackFired = true;
        },
      };

      const compactRes = await runChatEngineCompaction(compactionHost);
      assert.equal(compactRes, null);
      assert.equal(compactionLlmCalled, false, 'Compaction LLM call must be skipped when P11 cannot authorize capsule');
      assert.equal(blockedCallbackFired, true, 'onCompactionBlockedByAuthority must fire');
      assert.equal(
        threadLog.events.some((e) => e.kind === 'compaction_capsule'),
        false,
        'No unauthorizable compaction_capsule may be written to threadLog',
      );

      const installed = await authority.installP11ContextCheckpoint(route);
      assert.equal(installed, false);
      assert.equal(host.p11InstallBlock?.code, 'sources_unavailable');
      assert.equal(host.p11InstallBlock?.details.includes('workspace_revision'), true);
      assert.match(
        host.p11InstallBlock?.details.join(', ') ?? '',
        /workspace_revision_reason: Input file exceeds the closure size cap/,
      );
    } finally {
      rmSync(nonGitRoot, { recursive: true, force: true });
    }
  });
});

describe('Boundary 3: Tool start journaling for read_range and validator cross-artifact consistency check', () => {
  it('emits persistToolStartedAtExecutorDispatch before read_range executes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-readrange-'));
    try {
      writeFileSync(join(dir, 'sample.txt'), 'line1\nline2\nline3\n', 'utf8');
      const startedCalls: Array<{ type: string; index: number }> = [];
      const toolCallLog: Array<{ exit_code?: number }> = [];
      const res = await executeReadRangeAction({
        host: {
          options: { projectRoot: dir },
          persistToolStartedAtExecutorDispatch(action: { type: string }, meta: { index: number }) {
            startedCalls.push({ type: action.type, index: meta.index });
          },
          isSubmissionCurrent: () => true,
          settleStaleActionResult: () => ({ index: 0, observation: '' }),
          hashContent: (c: string) => c,
          readCacheKey: (p: string) => p,
          noteToolForReadThrash: () => {},
          readCache: new Map(),
          readContextEpoch: 0,
          toolCallLog,
          workingState: createWorkingState('inspect'),
          currentRecoveryBinding: () => null,
          persistRecoveryWorkingState: () => {},
          finishRecoveryLocalizationInspection: () => {},
        } as unknown as Parameters<typeof executeReadRangeAction>[0]['host'],
        action: { type: 'read_range', file_path: 'sample.txt', start_line: 1, end_line: 2 },
        tool: 'read_range',
        target: 'sample.txt:1-2',
        toolId: 1,
        meta: { index: 7 },
        ownerGeneration: 1,
        callbacks: {},
      });
      assert.equal(res.index, 7);
      assert.equal(toolCallLog[0]?.exit_code, 0);
      assert.equal(startedCalls.length, 1);
      assert.deepEqual(startedCalls[0], { type: 'read_range', index: 7 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails validateSessionRun when session-events.jsonl has tool_cancelled(TOOL_NOT_STARTED) for a tool that succeeded in thread_events.json', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-validator-cross-'));
    try {
      const log = createSessionEventLog('chat-contradiction');
      recordUserSubmitted(log, {
        turn_id: 'turn-1',
        task: 'test',
      });
      recordToolProposed(log, {
        turn_id: 'turn-1',
        tool_call_id: 'call_1',
        idempotency_key: 'idem_1',
        tool_name: 'read_range',
        target_summary: 'a.ts',
      });
      recordToolTerminal(log, {
        turn_id: 'turn-1',
        tool_call_id: 'call_1',
        idempotency_key: 'idem_1',
        tool_name: 'read_range',
        cancelled: true,
        recovery_state: 'TOOL_NOT_STARTED',
        reason: 'pre_dispatch_denied_or_invalid',
      });
      recordTurnEnded(log, {
        turn_id: 'turn-1',
        status: 'failed',
        outcome: 'INFRA_FAILURE',
      });

      rewriteSessionEventLog(runDir, log);
      writeFileSync(
        join(runDir, 'thread_events.json'),
        JSON.stringify({
          events: [
            {
              kind: 'tool_result',
              tool_call_id: 'call_1',
              tool_name: 'read_range',
              exit_code: 0,
              content: 'ok',
            },
          ],
        }),
        'utf8',
      );

      const validation = validateSessionRun(runDir);
      assert.equal(validation.status, 'FAIL');
      assert.equal(
        validation.findings.some((f) => f.invariant === 'cross_artifact_tool_lifecycle_consistency'),
        true,
      );
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe('Boundary 4: Compaction OpenRouter reportedCostUsd extraction and incomplete cost/token UI', () => {
  it('extracts data.usage.cost from OpenRouter compaction responses and forwards reportedCostUsd', async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          model: 'deepseek/deepseek-v4-flash-0731',
          choices: [{ message: { content: 'Compacted summary text' } }],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 300,
            cost: 0.00425,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      const manager = new CompactionManager();
      type RecordedUsage = {
        inferenceId: string;
        modelId: string;
        inputTokens: number | null;
        outputTokens: number | null;
        reportedCostUsd?: number | null;
      };
      const recordedUsages: RecordedUsage[] = [];
      const res = await manager.compactWithResult(
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'u1'.repeat(800) },
          { role: 'assistant', content: 'a1'.repeat(800) },
          { role: 'user', content: 'u2'.repeat(800) },
          { role: 'assistant', content: 'a2'.repeat(800) },
          { role: 'user', content: 'u3'.repeat(800) },
          { role: 'assistant', content: 'a3'.repeat(800) },
        ],
        {
          maxTokens: 200,
          model: 'deepseek/deepseek-v4-flash-0731',
          summarizationProvider: {
            apiKey: 'test-key-not-real',
            baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
            defaultModel: 'deepseek/deepseek-v4-flash-0731',
          },
          onUsageRecorded: (u) => {
            recordedUsages.push(u);
          },
        },
      );
      assert.equal(res.changed, true);
      assert.equal(recordedUsages.length, 1);
      assert.equal(recordedUsages[0]?.inputTokens, 1200);
      assert.equal(recordedUsages[0]?.outputTokens, 300);
      assert.equal(recordedUsages[0]?.reportedCostUsd, 0.00425);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('renders known subtotal + unpriced count in status bar and review card without hiding known spend', () => {
    const bar = stripAnsi(
      renderStatusBar({
        model: 'deepseek-v4-flash-0731',
        modelId: 'deepseek/deepseek-v4-flash-0731',
        mode: 'chat',
        project: 'Prismatix',
        totalCost: 0.0391,
        hasUnknownCost: true,
        unknownChargeCount: 1,
        totalTokens: 3_162_714,
        activeContext: {
          tokens: 78_263,
          modelId: 'deepseek/deepseek-v4-flash-0731',
          source: 'provider',
        },
        turnCount: 1,
        width: 160,
      }),
    );
    assert.match(bar, /session known \$0\.0391 \(1 unpriced\)/);

    const card = buildReviewCard({
      status: 'failed',
      outcome: 'INFRA_FAILURE',
      reasonCode: 'context_installation_blocked',
      costUsd: 0.0391,
      unknownChargeCount: 1,
      tokens: 3_162_714,
      activeContextTokens: 78_263,
    });
    const plainCard = stripAnsi(`${card.title}\n${card.body}`);
    assert.match(plainCard, /Context installation blocked/);
    assert.match(plainCard, /known \$0\.0391 this turn \(\+1 unpriced\)/);
    assert.match(plainCard, /3,162,714 tok  \(context 78,263 tok\)/);
  });
});

describe('Boundary 5: Typed context_installation_blocked terminal classification and causal attribution', () => {
  it('classifies P11 context installation failure text into context_installation_blocked and INFRA_FAILURE', () => {
    const errText =
      'P11 context installation was blocked (sources_unavailable: workspace_revision, workspace_revision_reason: file_exceeds_capture_limit:app-release.apk).';
    const reason = terminalReasonFromFailureText(errText);
    assert.deepEqual(reason, {
      code: 'context_installation_blocked',
      cause_class: 'harness',
    });
    assert.equal(outcomeFromReasonCode(reason?.code), 'INFRA_FAILURE');
    const guidance = terminalReasonGuidance('context_installation_blocked');
    assert.match(guidance.message, /Context checkpoint installation was blocked/);

    const projected = projectTurnViewState([
      {
        type: 'turn_terminal_resolved',
        timestamp: 1,
        status: 'failed',
        outcome: 'INFRA_FAILURE',
        reason_code: 'context_installation_blocked',
        cause_class: 'harness',
        finalAnswer: '',
      },
    ]);
    assert.equal(projected.reviewCard.title, 'Context installation blocked');
  });

  it('attributes P11 context installation failure in buildCausalAttributionReport over incidental tool_cancelled events', () => {
    const log = createSessionEventLog('chat-p11-attr');
    const inputRef = join(process.cwd(), 'src/agent/babelChatRepairRegressions.test.ts');
    appendSessionEvent(log, {
      kind: 'model_input_receipt',
      turn_id: 'turn-1',
      inference_id: 'inf-1',
      provider: 'openrouter',
      requested_model_id: 'deepseek/deepseek-v4-flash-0731',
      normalized_model_id: 'deepseek/deepseek-v4-flash-0731',
      sent_model_id: 'deepseek/deepseek-v4-flash-0731',
      input_digest: 'a'.repeat(64),
      input_ref: inputRef,
    });
    appendSessionEvent(log, {
      kind: 'model_result_delivery',
      turn_id: 'turn-1',
      inference_id: 'inf-1',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      observed_model_id: 'deepseek/deepseek-v4-flash-0731',
      status: 'delivered',
      tool_call_count: 1,
    });
    appendSessionEvent(log, {
      kind: 'completion_decision',
      turn_id: 'turn-1',
      requested_outcome: 'BLOCKED',
      final_outcome: 'FAILED',
      allowed: false,
      reason: 'P11 context installation was blocked (sources_unavailable: workspace_revision).',
      evidence_refs: [],
      policy_version: 'v1',
    });
    appendSessionEvent(log, {
      kind: 'turn_ended',
      turn_id: 'turn-1',
      status: 'failed',
      outcome: 'INFRA_FAILURE',
    });

    const report = buildCausalAttributionReport({
      log,
    });
    assert.equal(report.attribution.family, 'harness');
    assert.equal(report.attribution.code, 'context_installation_blocked');
    assert.equal(report.attribution.model_blame_permitted, false);
  });
});

function emulateTerminalCells(rawStream: string, cols = 80): string[] {
  // Strip SGR and DEC private mode codes while preserving \r, \n, and \x1b[K (EL - Erase in Line)
  const withoutSgr = rawStream.replace(/\x1b\[\??[0-9;]*[mhl]/g, '');
  const grid: string[][] = [Array.from({ length: cols }, () => ' ')];
  let row = 0;
  let col = 0;

  const ensureRow = (r: number) => {
    while (grid.length <= r) {
      grid.push(Array.from({ length: cols }, () => ' '));
    }
  };

  for (let i = 0; i < withoutSgr.length; i++) {
    if (withoutSgr.startsWith('\x1b[K', i) || withoutSgr.startsWith('\x1b[0K', i)) {
      const seqLen = withoutSgr.startsWith('\x1b[0K', i) ? 4 : 3;
      ensureRow(row);
      for (let c = col; c < cols; c++) {
        grid[row]![c] = ' ';
      }
      i += seqLen - 1;
      continue;
    }
    const ch = withoutSgr[i]!;
    if (ch === '\r') {
      col = 0;
      continue;
    }
    if (ch === '\n') {
      row += 1;
      col = 0;
      ensureRow(row);
      continue;
    }
    if (col >= cols) {
      row += 1;
      col = 0;
      ensureRow(row);
    }
    ensureRow(row);
    grid[row]![col] = ch;
    col += 1;
  }

  return grid.map((line) => line.join('').trimEnd()).filter((line) => line.length > 0);
}

describe('Boundary 6: ConversationalRenderer line clearing, single-row tool clamping, error box alignment, and timers', () => {
  it('clears transient tool lines with \\r\\x1b[K and clamps long targets so no stale suffix remains in an 80-col terminal cell grid', () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    const origCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    OutputBuffer.resetInstance();
    try {
      const renderer = new ConversationalRenderer({ isTTY: true });
      const id1 = renderer.onToolCallStart(
        'read_range',
        'Project_Apps/Prismatix/Prismatix-verify/android-twa/app/src/main/java/work/prismatix/app/Application.java',
      );
      renderer.onToolCallComplete(id1, 'lines 1-60');
      const id2 = renderer.onToolCallStart('read_range', 'package.json');
      renderer.onToolCallComplete(id2, 'lines 1-30');
      renderer.onAnswerChunk('Done.');
      renderer.stop();
      OutputBuffer.getInstance().flush();

      const raw = writes.join('');
      assert.equal(/\x1b\[\d*A/.test(raw), false, 'Must not emit destructive CUU cursor-up');
      assert.equal(raw.includes('\r\x1b[K'), true, 'Must emit \\r\\x1b[K when overwriting transient tool line');
      assert.equal(raw.includes('[Esc] cancel'), false, 'Post-stop footer must not show dead [Esc] cancel hint');
      assert.equal(raw.includes('[Ctrl+C] stop'), false, 'Post-stop footer must not show dead [Ctrl+C] stop hint');

      const screenLines = emulateTerminalCells(raw, 80);
      const readBatchLine = screenLines.find((l) => l.includes('Read 2 files'));
      assert.ok(readBatchLine, `Expected completed read batch line in screen grid: ${JSON.stringify(screenLines)}`);
      for (const line of screenLines) {
        assert.equal(
          line.includes('java'),
          false,
          `Stale suffix from Application.java bled into 80-col screen grid: ${line}`,
        );
      }
    } finally {
      process.stdout.write = origWrite;
      Object.defineProperty(process.stdout, 'columns', { value: origCols, configurable: true });
      OutputBuffer.resetInstance();
    }
  });

  it('aligns all right borders in renderErrorBox to identical visible width', () => {
    const lines = renderErrorBox('P11 context installation was blocked.', undefined, 80);
    const widths = lines.map((line) => visibleLength(line));
    const uniqueWidths = [...new Set(widths)];
    assert.equal(uniqueWidths.length, 1, `Expected uniform box width, got ${JSON.stringify(widths)}`);
  });

  it('shows both turn elapsed and current request timer when multi-step turn elapsed diverges from request wait', () => {
    const singleReq = formatConversationThinkingStatus({
      spinner: '◐',
      stallMs: 0,
      snapshot: { elapsedMs: 7_300, phase: 'investigate', modelIdleMs: 6_000 },
    });
    assert.match(stripAnsi(singleReq.timer), /^\(response 7s · Ctrl\+C cancel\)$/);

    const multiStep = formatConversationThinkingStatus({
      spinner: '◐',
      stallMs: 0,
      snapshot: { elapsedMs: 125_000, phase: 'investigate', modelIdleMs: 14_000 },
    });
    assert.match(stripAnsi(multiStep.timer), /^\(response 125s · req 14s · Ctrl\+C cancel\)$/);
  });
});

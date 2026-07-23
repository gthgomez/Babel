// ─── Governed Task Execution ────────────────────────────────────────────────
// Extracted from interactive.ts — full governed pipeline: orchestrate → plan →
// review → execute, with waterfall or conversational rendering.

import * as path from 'node:path';
import type { ReplContext } from '../context.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { runBabelPipeline, BabelEventBus } from '../../pipeline.js';
import { createJsonEventStream } from '../../services/eventStream.js';
import { createLiveRunRenderer, ConversationalRenderer } from '../../ui/waterfall.js';
import {
  stdinCoordinatorPauseForRun,
  stdinCoordinatorResumeAfterRun,
} from '../../ui/inputCoordinator.js';
import {
  prepareContextInjection,
  summarizeContextInjection,
  writeContextInjectionEvidence,
} from '../../services/contextInjection.js';
import { globalCostTracker } from '../../services/costTracker.js';
import {
  buildRunResultPayload,
  formatRunResultHuman,
  writeHumanSummaryArtifact,
  formatHumanOutputReviewNote,
} from '../../cli/structuredOutput.js';
import type { ValidMode } from '../../cli/constants.js';
import { muted, dim } from '../../ui/theme.js';
import { userStatusForRun } from '../utils.js';
import { updateConversationMemory } from '../turns.js';
import { printRunSummary } from './summary.js';
import { alert } from '../../ui/dialog.js';

export async function executeGovernedTask(
  ctx: ReplContext,
  input: string,
  task: string,
  target: AgentTargetContext,
  modeOverride?: ValidMode,
): Promise<void> {
  ctx.isRunning = true;
  stdinCoordinatorPauseForRun(ctx.rl);
  process.stdout.write('[?25l'); // hide cursor

  const bus = new BabelEventBus();
  const eventStream = process.env['BABEL_EVENTS_JSONL']
    ? createJsonEventStream(process.env['BABEL_EVENTS_JSONL'], { bus, runLabel: task.slice(0, 80) })
    : null;
  const onVerboseLog = ctx.verboseMode
    ? (line: string) => {
        process.stdout.write(`${muted(line)}\n`);
      }
    : undefined;
  const onVerboseRuntime = ctx.verboseMode
    ? (event: { event_type?: string; payload?: Record<string, unknown> }) => {
        const label = event.payload?.['tool'] ?? event.event_type ?? 'runtime';
        process.stdout.write(`${dim(`[${event.event_type ?? 'runtime'}] ${String(label)}`)}\n`);
      }
    : undefined;
  if (onVerboseLog) {
    bus.on('log', onVerboseLog);
  }
  if (onVerboseRuntime) {
    bus.on('runtime_event', onVerboseRuntime);
  }
  bus.on('stage', (idx: number) => {
    ctx.currentStageIdx = idx;
  });
  const projectRoot = target.targetRoot;
  ctx.lastTargetRoot = target.targetRoot;
  ctx.lastWorkspaceRoot = target.workspaceRoot;
  ctx.state.lastRunTargetRoot = target.targetRoot;
  const activeMode = modeOverride ?? ctx.state.mode;
  // Render mode may be overridden by /compact toggle: on = always conversational, off = always waterfall
  const compactMode = ctx.state.compactMode;
  const renderMode = compactMode === 'on' ? 'chat' : compactMode === 'off' ? 'deep' : activeMode;
  const waterfall = createLiveRunRenderer(
    bus,
    {
      task,
      mode: renderMode,
      project: ctx.state.project,
      projectRoot,
    },
    process.stdout,
  );

  // Wire ConversationalRenderer to event bus for chat/compact mode
  const toolCallIds = new Map<string, number>();
  if (waterfall instanceof ConversationalRenderer) {
    const conv = waterfall;
    bus.on('assistant_chunk', ({ chunk }: { chunk: string }) => {
      conv.onAnswerChunk(chunk);
    });
    bus.on('assistant_thought', (thought: unknown) => {
      if (typeof thought === 'string') {
        conv.onThought(thought);
      }
    });
    bus.on('runtime_event', (event: any) => {
      const { event_type, payload } = event ?? {};
      if (event_type === 'tool.requested' && payload?.tool) {
        const key = `${payload.tool}:${payload.target ?? ''}`;
        const id = conv.onToolCallStart(payload.tool, payload.target ?? '');
        if (id >= 0) toolCallIds.set(key, id);
      } else if (event_type === 'tool.completed' && payload?.tool) {
        const key = `${payload.tool}:${payload.target ?? ''}`;
        const id = toolCallIds.get(key);
        if (id !== undefined) {
          conv.onToolCallComplete(id, payload.detail as string | undefined);
          toolCallIds.delete(key);
        }
        // Forward file diff info to renderer
        if (payload.diff && Array.isArray(payload.diff)) {
          for (const d of payload.diff) {
            conv.onFileChanged(d.path, d.additions, d.deletions, d.content);
          }
        }
      }
    });
    bus.on('log', (line: string) => {
      // Check for [tool] prefix from createLiteToolStreamSink
      const toolMatch = String(line).match(
        /^\[tool\] (\w+) (.+) \((…|ok|fail|blocked)\)(?: \((.*)\))?$/,
      );
      if (toolMatch) {
        const tool = toolMatch[1];
        const target = toolMatch[2];
        const status = toolMatch[3];
        const detail = toolMatch[4];
        const key = `${tool}:${target}`;
        if (status === '…') {
          const id = conv.onToolCallStart(tool, target);
          if (id >= 0) toolCallIds.set(key, id);
        } else {
          const id = toolCallIds.get(key);
          if (id !== undefined) {
            conv.onToolCallComplete(id, detail);
            toolCallIds.delete(key);
          }
        }
      }
    });
  }

  // Set task label for desktop completion notifications
  if (typeof (waterfall as any).setTaskLabel === 'function') {
    (waterfall as any).setTaskLabel(task);
  }

  const preRunCost = globalCostTracker.getSessionSummary().totalCostUSD;
  try {
    waterfall.start();
    const contextInjection = prepareContextInjection(task, { projectRoot });
    if (contextInjection.attachments.length > 0) {
      ctx.logBuffer.push(`context: ${summarizeContextInjection(contextInjection)}`);
    }
    const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
    process.env['BABEL_PROJECT_ROOT'] = projectRoot;
    let result;
    try {
      result = await runBabelPipeline(contextInjection.task, {
        ...(ctx.state.project !== undefined ? { project: ctx.state.project } : {}),
        mode: activeMode,
        orchestratorVersion: ctx.state.router,
        ...(ctx.state.model !== undefined ? { modelOverride: ctx.state.model } : {}),
        eventBus: bus,
      });
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
      }
    }

    waterfall.stop();
    const snapshot = (waterfall as any).getFinalSnapshot?.() ?? '';
    if (snapshot) {
      ctx.lastRunTranscript = snapshot;
    }
    // ConversationalRenderer: show compact summary with elapsed time and cost
    if (waterfall instanceof ConversationalRenderer) {
      const conv = waterfall;
      const sessionCost = globalCostTracker.getSessionSummary();
      const changedFiles = result?.terminalSummary?.changed_files ?? [];
      const postRunCost = sessionCost.totalCostUSD;
      const perRunCost = Math.max(0, postRunCost - preRunCost);
      conv.onSummary({
        status: result?.status ?? '',
        costUSD: postRunCost,
        perRunCost,
        changedFiles,
      });
    }
    ctx.lastRunDir = result.runDir;
    ctx.state.lastRunUserStatus = userStatusForRun(result.status);
    if (contextInjection.attachments.length > 0) {
      writeContextInjectionEvidence(result.runDir, contextInjection);
    }
    eventStream?.write('babel.run.result', { run_dir: result.runDir, status: result.status });

    // Update project-level financials
    globalCostTracker.saveToProjectStats(path.basename(result.runDir));

    const isConversational = waterfall instanceof ConversationalRenderer;
    if (isConversational) {
      // ── Conversational mode: answer was already streamed ──────────────
      // Update internal state + write artifacts, but skip the structured output dump
      const convPayload = buildRunResultPayload(result, {
        task,
        mode: ctx.state.mode,
        ...(ctx.state.project !== undefined ? { project: ctx.state.project } : {}),
        ...(projectRoot ? { projectRoot } : {}),
        orchestrator: ctx.state.router,
        ...(ctx.state.model !== undefined ? { requestedModel: ctx.state.model } : {}),
      });
      const convHuman = formatRunResultHuman(convPayload);
      const transcript = [
        input ? `You: ${input}` : '',
        typeof waterfall.getTranscript === 'function' ? waterfall.getTranscript() : '',
        convHuman,
      ]
        .filter(Boolean)
        .join('\n');
      ctx.lastRunTranscript = transcript;
      writeHumanSummaryArtifact(result.runDir, convHuman, transcript);
      updateConversationMemory(ctx, convPayload, task);
      const changedFiles = Array.isArray(convPayload['changed_files'])
        ? convPayload['changed_files'].filter((entry): entry is string => typeof entry === 'string')
        : [];
      const verification =
        convPayload['verification'] && typeof convPayload['verification'] === 'object'
          ? String((convPayload['verification'] as Record<string, unknown>)['status'] ?? '')
          : null;
      ctx.appendTurn({
        role: 'assistant',
        ...(ctx.lastAssistantAnswer
          ? { answer: ctx.lastAssistantAnswer, summary: ctx.lastAssistantAnswer }
          : {}),
        run_dir: result.runDir,
        changed_files: changedFiles,
        verification,
        next: ctx.lastAssistantNext,
      });
      // Compact cost footer only (no structured output dump)
      const convSessionCost = globalCostTracker.getSessionSummary();
      const costLine =
        typeof convSessionCost.totalCostUSD === 'number'
          ? `$${convSessionCost.totalCostUSD.toFixed(4)}`
          : '--';
      console.log(
        dim(
          `  ${userStatusForRun(result.status)} | Session cost: ${costLine} | Next: /inspect, or type your next task\n`,
        ),
      );
    } else {
      process.stdout.write('[?25h');
      printRunSummary(ctx, result, {
        input,
        task,
        projectRoot,
        transcript: typeof waterfall.getTranscript === 'function' ? waterfall.getTranscript() : '',
      });
    }
  } catch (caughtError: any) {
    ctx.state.lastRunUserStatus = 'failed';
    waterfall.fail();
    eventStream?.write('babel.run.error', { error: caughtError.message });
    process.stdout.write('[?25h');
    const runDir = typeof caughtError?.runDir === 'string' ? caughtError.runDir : null;
    if (runDir) {
      ctx.lastRunDir = runDir;
    }
    const errorPayload: Record<string, unknown> = {
      status: 'RUN_FAILED',
      user_status: 'failed',
      command: 'run',
      task,
      project: ctx.state.project ?? null,
      run_dir: runDir,
      changed_files: [],
      verification: {
        status: 'skipped',
        commands: [],
        skipped_reason: caughtError.message ?? String(caughtError),
      },
      checkpoint: {
        required: false,
        available: false,
        restore_command: null,
        inspect_command: null,
      },
      evidence: {
        run_dir: runDir,
        support_path: runDir,
        artifacts: [],
      },
      checks: [],
      usage: globalCostTracker.getSessionSummary(),
      errors: [caughtError.message ?? String(caughtError)],
      next: [
        'Retry after resolving the failure or inspect the run evidence if a run directory was created.',
      ],
    };
    const human = formatRunResultHuman(errorPayload);
    if (runDir) {
      const review = writeHumanSummaryArtifact(
        runDir,
        human,
        [typeof waterfall.getTranscript === 'function' ? waterfall.getTranscript() : '', human]
          .filter(Boolean)
          .join('\n'),
      );
      const note = formatHumanOutputReviewNote(review);
      if (note) {
        console.log(muted(`  ${note}\n`));
      }
    }
    updateConversationMemory(ctx, errorPayload, task);
    ctx.appendTurn({
      role: 'assistant',
      ...(ctx.lastAssistantAnswer ? { answer: ctx.lastAssistantAnswer } : {}),
      summary: caughtError.message ?? String(caughtError),
      run_dir: runDir,
      target_root: target.targetRoot,
      workspace_root: target.workspaceRoot,
      changed_files: [],
      verification: 'failed',
      next: ctx.lastAssistantNext,
    });
    console.error(`\n${human}\n`);
    if (process.stdout.isTTY && !process.env['CI']) {
      try {
        await alert({
          title: 'Task Execution Failed',
          message: caughtError.message ?? String(caughtError),
        });
        (caughtError as any)[Symbol.for('babel.error.alerted')] = true;
      } catch {
        // alert() itself failed (e.g. terminal disconnect) — already logged above
      }
    }
  } finally {
    await eventStream?.close();
    bus.removeAllListeners();
    ctx.isRunning = false;
    stdinCoordinatorResumeAfterRun(ctx.rl);
  }
}

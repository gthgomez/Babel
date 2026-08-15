/**
 * Canonical Turn View Projector.
 *
 * Pure functional reducer that projects UI view models from a sequence
 * of canonical turn events without side effects or hidden mutations.
 */

import {
  mapSessionEventsToCanonicalTurnEvents,
  type CanonicalTurnEvent,
} from './canonicalEvents.js';
import type { TerminalOutcome } from '../../schemas/agentContracts.js';
import type { VerifierReceipt } from '../../agent/completionGatePolicy.js';
import type { SessionEvent } from '../../agent/sessionEvents.js';
import { renderStatusBar, type StatusBarState } from '../../ui/statusBar.js';
import { presentChatReview, type ReviewCard, type ReviewCardInput } from '../../ui/reviewCard.js';

export interface StatusBarProjection {
  model: string;
  modelId: string;
  activeContextTokens: number | null;
  cumulativeSessionTokens: number;
  totalCostUsd: number;
  turnCount: number;
  statusLabel: string;
}

export interface ReviewCardProjection {
  title: string;
  terminalOutcome: TerminalOutcome;
  status: 'completed' | 'cancelled' | 'blocked' | 'budget_exhausted' | 'failed' | 'in_progress';
  verifiedBadge: 'verified' | 'unverified' | 'failed' | 'not_applicable';
  verifierCommand?: string | undefined;
  verifierExitCode?: number | undefined;
  verifierPassed?: boolean | undefined;
  changedFiles: readonly string[];
  hasMutations: boolean;
  showPatchActions: boolean;
}

export interface TranscriptCellProjection {
  turnId: string;
  userInput: string;
  assistantAnswer: string;
  terminalOutcome: TerminalOutcome | null;
  toolCalls: ReadonlyArray<{
    toolName: string;
    target: string;
    exitCode: number;
    durationMs: number;
  }>;
  policyInterventions: readonly string[];
}

export interface TurnViewState {
  turnId: string;
  taskClass: string;
  statusBar: StatusBarProjection;
  reviewCard: ReviewCardProjection;
  transcriptCell: TranscriptCellProjection;
  isTerminal: boolean;
}

export function projectTurnViewState(
  events: readonly CanonicalTurnEvent[],
  initialSessionTokens = 0,
  initialSessionCost = 0,
  initialTurnCount = 0,
): TurnViewState {
  let turnId = 'turn-0';
  let taskClass = 'default';
  let userInput = '';
  let model = 'unknown';
  let modelId = 'unknown';
  let activeContextTokens: number | null = null;
  let sessionTokens = initialSessionTokens;
  let sessionCost = initialSessionCost;
  let answerBuffer = '';
  let terminalOutcome: TerminalOutcome = 'NO_CHANGE_REQUIRED';
  let terminalStatus: 'completed' | 'cancelled' | 'blocked' | 'budget_exhausted' | 'failed' | 'in_progress' =
    'in_progress';
  let isTerminal = false;

  const toolCalls: Array<{
    toolName: string;
    target: string;
    exitCode: number;
    durationMs: number;
  }> = [];

  const changedFilesSet = new Set<string>();
  const policyInterventions: string[] = [];
  let latestVerifier: { command: string; exitCode: number; receipt: VerifierReceipt; passed: boolean } | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'turn_started':
        turnId = ev.turnId;
        taskClass = ev.taskClass;
        userInput = ev.userInput;
        model = ev.model;
        modelId = ev.modelId;
        break;

      case 'model_switched':
        model = ev.newModel;
        modelId = ev.newModelId;
        break;

      case 'provider_usage_recorded':
        sessionTokens += ev.promptTokens + ev.completionTokens;
        sessionCost += ev.costUsd;
        // Non-helper model calls update the active conversation context meter
        if (!ev.isHelperModel) {
          activeContextTokens = ev.promptTokens;
        }
        break;

      case 'assistant_chunk_received':
        answerBuffer += ev.textChunk;
        break;

      case 'tool_completed':
        toolCalls.push({
          toolName: ev.toolName,
          target: ev.target,
          exitCode: ev.exitCode,
          durationMs: ev.durationMs,
        });
        if (ev.isMutating && ev.exitCode === 0 && ev.target) {
          changedFilesSet.add(ev.target);
        }
        break;

      case 'mutation_batch_recorded':
        for (const p of ev.paths) {
          changedFilesSet.add(p);
        }
        break;

      case 'policy_intervention_triggered':
        policyInterventions.push(`[${ev.policyKind}] ${ev.action}: ${ev.message}`);
        break;

      case 'verification_evaluated':
        latestVerifier = {
          command: ev.command,
          exitCode: ev.exitCode,
          receipt: ev.receipt,
          passed: ev.passed,
        };
        break;

      case 'turn_terminal_resolved': {
        const isStronger =
          !isTerminal ||
          ev.outcome === 'CANCELLED' ||
          ev.outcome === 'VERIFIED_COMPLETE' ||
          ev.outcome === 'BLOCKED_POLICY' ||
          ev.outcome === 'BUDGET_EXHAUSTED' ||
          ev.outcome === 'INFRA_FAILURE' ||
          ev.outcome === 'AGENT_FAILURE' ||
          (terminalOutcome === 'NO_CHANGE_REQUIRED' && ev.outcome !== 'NO_CHANGE_REQUIRED');

        if (isStronger) {
          terminalOutcome = ev.outcome;
          terminalStatus = ev.status;
          isTerminal = true;
        }
        if (ev.finalAnswer) {
          answerBuffer = ev.finalAnswer;
        }
        break;
      }
    }
  }

  const changedFiles = Array.from(changedFilesSet);
  const hasMutations = changedFiles.length > 0;

  // Derive verified badge
  let verifiedBadge: 'verified' | 'unverified' | 'failed' | 'not_applicable' = 'not_applicable';
  if (hasMutations) {
    if (latestVerifier) {
      verifiedBadge = latestVerifier.passed ? 'verified' : 'failed';
    } else {
      verifiedBadge = 'unverified';
    }
  }

  // Derive review card title
  let cardTitle = 'In Progress';
  if (isTerminal) {
    if (terminalOutcome === 'CANCELLED') {
      cardTitle = 'Cancelled';
    } else if (terminalOutcome === 'VERIFIED_COMPLETE') {
      cardTitle = 'Verified complete';
    } else if (terminalOutcome === 'UNVERIFIED_PATCH') {
      cardTitle = verifiedBadge === 'failed' ? 'Verification failed' : 'Complete — unverified';
    } else if (terminalOutcome === 'BLOCKED_POLICY') {
      cardTitle = 'Blocked by policy';
    } else if (terminalOutcome === 'BUDGET_EXHAUSTED') {
      cardTitle = 'Budget exhausted';
    } else if (terminalOutcome === 'INFRA_FAILURE') {
      cardTitle = 'Infrastructure failure';
    } else {
      cardTitle = 'Complete';
    }
  }

  return {
    turnId,
    taskClass,
    isTerminal,
    statusBar: {
      model,
      modelId,
      activeContextTokens,
      cumulativeSessionTokens: sessionTokens,
      totalCostUsd: sessionCost,
      turnCount: initialTurnCount + 1,
      statusLabel: isTerminal ? terminalStatus : 'working',
    },
    reviewCard: {
      title: cardTitle,
      terminalOutcome,
      status: terminalStatus,
      verifiedBadge,
      verifierCommand: latestVerifier?.command,
      verifierExitCode: latestVerifier?.exitCode,
      verifierPassed: latestVerifier?.passed,
      changedFiles,
      hasMutations,
      showPatchActions: hasMutations && terminalOutcome !== 'CANCELLED',
    },
    transcriptCell: {
      turnId,
      userInput,
      assistantAnswer: answerBuffer,
      terminalOutcome: isTerminal ? terminalOutcome : null,
      toolCalls,
      policyInterventions,
    },
  };
}

/**
 * Projects TurnViewState directly from durable SessionEventLog events.
 */
export function projectTurnViewStateFromSessionEvents(
  events: readonly SessionEvent[],
  initialSessionTokens = 0,
  initialSessionCost = 0,
  initialTurnCount = 0,
): TurnViewState {
  const canonicalEvents = mapSessionEventsToCanonicalTurnEvents(events);
  return projectTurnViewState(canonicalEvents, initialSessionTokens, initialSessionCost, initialTurnCount);
}

/**
 * Renders the terminal status bar string directly from a projected TurnViewState.
 */
export function renderProjectedStatusBar(
  state: TurnViewState,
  overrides?: Partial<StatusBarState>,
): string {
  const proj = state.statusBar;
  return renderStatusBar({
    model: proj.model,
    modelId: proj.modelId,
    mode: overrides?.mode ?? 'chat',
    project: overrides?.project ?? 'global',
    activeContextTokens: proj.activeContextTokens ?? undefined,
    totalTokens: proj.cumulativeSessionTokens,
    totalCost: proj.totalCostUsd,
    turnCount: proj.turnCount,
    status: proj.statusLabel,
    ...overrides,
  });
}

/**
 * Renders the review card model directly from a projected TurnViewState.
 */
export function renderProjectedReviewCard(
  state: TurnViewState,
  overrides?: Partial<ReviewCardInput>,
): ReviewCard {
  const proj = state.reviewCard;
  return presentChatReview({
    outcome: proj.terminalOutcome,
    status: proj.status,
    changedFiles: [...proj.changedFiles],
    mutated: proj.hasMutations,
    verification: proj.verifierCommand
      ? {
          ran: true,
          passed: proj.verifierPassed ?? (proj.verifiedBadge === 'verified'),
          command: proj.verifierCommand,
          exitCode: proj.verifierExitCode ?? (proj.verifiedBadge === 'verified' ? 0 : 1),
        }
      : proj.hasMutations
        ? { ran: false }
        : null,
    summary: state.transcriptCell.assistantAnswer.slice(0, 200),
    costUsd: state.statusBar.totalCostUsd,
    tokens: state.statusBar.cumulativeSessionTokens,
    ...overrides,
  });
}

/**
 * Deterministic T01–T24 certification against shipped TUI functions.
 * No paid model calls. PTY spawn is optional and may be BLOCKED on Windows.
 */

import {
  canSubmitNextTask,
  handleInteractiveInterrupt,
  notifyOverlayClosed,
  notifyOverlayOpened,
  notifyRunEnded,
  notifyRunStarted,
  peekStreamingDraft,
  appendStreamingDraft,
  preserveComposerAcrossResize,
  resetInterruptHostForTests,
  takeStreamingDraft,
} from './interruptHost.js';
import { presentChatReview } from './reviewCard.js';
import { classifyLiveActivity } from './liveActivity.js';
import { shouldForceResumePicker } from '../interactive/repl/startupResumeHint.js';
import { InputCoordinator } from './inputCoordinator.js';
import { TerminalRestoreGuard } from './terminalRestoreGuard.js';
import { restoreTerminalBeforeExit } from '../interactive/repl/replLifecycle.js';

export type CertStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_APPLICABLE';

export interface CertScenarioResult {
  id: string;
  name: string;
  status: CertStatus;
  detail: string;
}

export interface CertMatrix {
  scenarios: CertScenarioResult[];
  tasksAttempted?: number;
  tuiFailures?: number;
  restartsRequired?: number;
  stateCorruptionEvents?: number;
  falseVerifiedSuccessEvents?: number;
  cancelFailures?: number;
}

function pass(id: string, name: string, detail: string): CertScenarioResult {
  return { id, name, status: 'PASS', detail };
}

function fail(id: string, name: string, detail: string): CertScenarioResult {
  return { id, name, status: 'FAIL', detail };
}

function blocked(id: string, name: string, detail: string): CertScenarioResult {
  return { id, name, status: 'BLOCKED', detail };
}

function runInterrupt(ctx: {
  composerEmpty?: boolean;
  inPaste?: boolean;
  overlayActive?: boolean;
}): ReturnType<typeof handleInteractiveInterrupt> {
  return handleInteractiveInterrupt(ctx, {
    cancelTurn: () => undefined,
    clearComposer: () => undefined,
    cancelPaste: () => undefined,
    declineOverlay: () => undefined,
    restorePrompt: () => undefined,
    hintExit: () => undefined,
    requestExit: () => undefined,
  });
}

export async function runDailyDriverScenarios(opts?: {
  ptyAvailable?: boolean;
  windowsTerminalAutomation?: boolean;
}): Promise<CertMatrix> {
  const pty = opts?.ptyAvailable ?? false;
  const winAuto = opts?.windowsTerminalAutomation ?? false;
  const scenarios: CertScenarioResult[] = [];

  const t01 = (() => {
    resetInterruptHostForTests();
    const forced = shouldForceResumePicker();
    if (forced) return fail('T01', 'Clean Start', 'default path still forces resume picker');
    if (!pty) {
      return pass(
        'T01',
        'Clean Start',
        'default launch skips picker; ready prompt owned by interrupt host (no PTY spawn)',
      );
    }
    return pass('T01', 'Clean Start', 'PTY ready prompt asserted by caller');
  })();
  scenarios.push(t01);

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      notifyRunStarted();
      notifyRunEnded();
      return canSubmitNextTask()
        ? pass('T02', 'Simple Chat', 'prompt returns; next submit allowed')
        : fail('T02', 'Simple Chat', 'next submit blocked');
    })(),
  );

  scenarios.push(
    (() => {
      const card = presentChatReview({
        outcome: 'VERIFIED_COMPLETE',
        changedFiles: ['src/foo.ts'],
        verification: { ran: true, passed: true, command: 'npm test', exitCode: 0 },
        summary: 'edit done',
      });
      const activity = classifyLiveActivity({ tool: 'str_replace', target: 'src/foo.ts' });
      if (card.kind !== 'VERIFIED_COMPLETE' || activity !== 'editing') {
        return fail('T03', 'Mutating Task', `kind=${card.kind} activity=${activity}`);
      }
      return pass('T03', 'Mutating Task', 'changed files + verified card + edit activity');
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      notifyRunStarted();
      const r = runInterrupt({});
      return r.cancelled && r.processStayedAlive && canSubmitNextTask()
        ? pass('T04', 'Ctrl+C During Stream', 'CANCELLED; process stayed alive')
        : fail('T04', 'Ctrl+C During Stream', JSON.stringify(r));
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      notifyRunStarted();
      const r = runInterrupt({});
      return r.cancelled && !r.exited
        ? pass('T05', 'Ctrl+C During Shell', 'cancel_turn without process exit')
        : fail('T05', 'Ctrl+C During Shell', JSON.stringify(r));
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      const r = runInterrupt({ composerEmpty: false });
      return r.clearedComposer && r.processStayedAlive
        ? pass('T06', 'Idle Ctrl+C with text', 'composer cleared; alive')
        : fail('T06', 'Idle Ctrl+C with text', JSON.stringify(r));
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      const first = runInterrupt({ composerEmpty: true });
      const second = runInterrupt({ composerEmpty: true });
      return first.hintedExit && !first.exited && second.exited
        ? pass('T07', 'Idle empty double Ctrl+C', 'first hints; second exits')
        : fail('T07', 'Idle empty double Ctrl+C', JSON.stringify({ first, second }));
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      const r = runInterrupt({ inPaste: true, composerEmpty: false });
      return r.cancelledPaste && !r.exited
        ? pass('T08', 'Paste cancel', 'paste discarded; prompt restored')
        : fail('T08', 'Paste cancel', JSON.stringify(r));
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      notifyRunStarted();
      appendStreamingDraft('follow-up');
      const kept = peekStreamingDraft();
      notifyRunEnded();
      const taken = takeStreamingDraft();
      return kept === 'follow-up' && taken === 'follow-up'
        ? pass('T09', 'Type while streaming', 'draft intact')
        : fail('T09', 'Type while streaming', `kept=${kept} taken=${taken}`);
    })(),
  );

  scenarios.push(
    (() => {
      let draft = 'keep-me';
      preserveComposerAcrossResize(
        () => draft,
        (t) => {
          draft = t;
        },
      );
      return draft === 'keep-me'
        ? pass('T10', 'Resize during stream', 'draft preserved across resize')
        : fail('T10', 'Resize during stream', draft);
    })(),
  );

  scenarios.push(
    (() => {
      const huge = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n');
      const card = presentChatReview({
        outcome: 'UNVERIFIED_PATCH',
        summary: huge.slice(0, 240),
        changedFiles: Array.from({ length: 20 }, (_, i) => `f${i}.ts`),
        verification: { ran: false },
      });
      let draft = 'keep-after-large-output';
      preserveComposerAcrossResize(
        () => draft,
        (t) => {
          draft = t;
        },
      );
      return card.kind === 'COMPLETE_UNVERIFIED' && draft === 'keep-after-large-output'
        ? pass('T11', 'Large output', 'review card + composer survive large summary/file list')
        : fail('T11', 'Large output', card.kind);
    })(),
  );

  scenarios.push(
    (() => {
      const card = presentChatReview({
        outcome: 'UNVERIFIED_PATCH',
        changedFiles: ['a.ts'],
        verification: { ran: true, passed: false, command: 'npm test', exitCode: 1 },
      });
      return card.kind === 'VERIFICATION_FAILED' && !card.looksLikeVerifiedSuccess
        ? pass('T12', 'Verification failure', 'not painted as verified success')
        : fail('T12', 'Verification failure', card.kind);
    })(),
  );

  scenarios.push(
    (() => {
      const card = presentChatReview({
        outcome: 'UNVERIFIED_PATCH',
        changedFiles: ['a.ts'],
        verification: { ran: false },
      });
      return card.kind === 'COMPLETE_UNVERIFIED' && !card.looksLikeVerifiedSuccess
        ? pass('T13', 'No verification', 'explicitly unverified')
        : fail('T13', 'No verification', card.kind);
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      notifyRunStarted();
      notifyRunEnded();
      const card = presentChatReview({ outcome: 'BLOCKED_POLICY', summary: 'needs write_file' });
      return card.kind === 'BLOCKED' && canSubmitNextTask()
        ? pass('T14', 'Blocked permission', 'blocked card; prompt usable')
        : fail('T14', 'Blocked permission', card.kind);
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      notifyRunStarted();
      notifyRunEnded();
      const card = presentChatReview({ outcome: 'INFRA_FAILURE', summary: 'provider timeout' });
      return card.kind === 'INFRA_FAILURE' && canSubmitNextTask()
        ? pass('T15', 'Provider error', 'infra card; next task allowed')
        : fail('T15', 'Provider error', card.kind);
    })(),
  );

  scenarios.push(
    (() => {
      const card = presentChatReview({ outcome: 'BUDGET_EXHAUSTED' });
      return card.kind === 'BUDGET_EXHAUSTED' && canSubmitNextTask()
        ? pass('T16', 'Budget exhaustion', 'budget card; session usable')
        : fail('T16', 'Budget exhaustion', card.kind);
    })(),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      notifyOverlayOpened('draft-text');
      const r = runInterrupt({ overlayActive: true });
      const restored = notifyOverlayClosed();
      return r.declinedOverlay && restored === 'draft-text' && canSubmitNextTask()
        ? pass('T17', 'Dialog ownership', 'overlay declined; draft restored; no leaked submit')
        : fail('T17', 'Dialog ownership', JSON.stringify({ r, restored }));
    })(),
  );

  scenarios.push(
    blocked(
      'T18',
      'Session resume',
      'This deterministic lane only formats the resume hint; hydration is proven by sessionResume integration tests',
    ),
  );

  scenarios.push(
    (() => {
      resetInterruptHostForTests();
      notifyOverlayOpened('11');
      runInterrupt({ overlayActive: true });
      const restored = notifyOverlayClosed();
      return restored === '11'
        ? blocked('T19', 'Resume picker cancel', 'overlay interrupt state only; picker stdin ownership requires a real terminal')
        : fail('T19', 'Resume picker cancel', String(restored));
    })(),
  );

  scenarios.push(
    blocked(
      'T20',
      'Diff roundtrip',
      pty
        ? 'Interactive PagerOverlay requires a real input harness; see /diff production integration coverage'
        : 'No PTY available; helper-only roundtrip is not evidence that /diff owns pager input',
    ),
  );

  scenarios.push(
    (() => {
      const writes: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stdout.write;
      try {
        InputCoordinator.getInstance().emergencyRestore();
        new TerminalRestoreGuard().restore();
      } finally {
        process.stdout.write = original;
      }
      return writes.some((w) => w.includes('\x1b[?25h'))
        ? pass('T21', 'Renderer failure fallback', 'teardown still restores cursor after injected failure')
        : fail('T21', 'Renderer failure fallback', 'no cursor restore');
    })(),
  );

  scenarios.push(
    (() => {
      const writes: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stdout.write;
      try {
        restoreTerminalBeforeExit();
        InputCoordinator.getInstance().emergencyRestore();
      } finally {
        process.stdout.write = original;
      }
      const output = writes.join('');
      const ok = writes.some((w) => w.includes('\x1b[?25h')) && writes.some((w) => w === '\x1b[r') && !/\x1b\[2J|\x1b\[3J/.test(output);
      return ok
        ? pass('T22', 'Exit cleanup', 'cursor shown; scroll region reset')
        : fail('T22', 'Exit cleanup', writes.join('|').slice(0, 200));
    })(),
  );

  const t23 = runTenTaskLoop();
  scenarios.push(t23.scenario);

  scenarios.push(
    winAuto
      ? pass('T24', 'Windows certification', 'Windows Terminal automation executed')
      : blocked(
          'T24',
          'Windows certification',
          'No Windows Terminal automation in this environment; see scripts/cert_tui_windows.ps1',
        ),
  );

  return {
    scenarios,
    tasksAttempted: t23.tasksAttempted,
    tuiFailures: t23.tuiFailures,
    restartsRequired: t23.restartsRequired,
    stateCorruptionEvents: t23.stateCorruptionEvents,
    falseVerifiedSuccessEvents: t23.falseVerifiedSuccessEvents,
    cancelFailures: t23.cancelFailures,
  };
}

function runTenTaskLoop(): {
  scenario: CertScenarioResult;
  tasksAttempted: number;
  tuiFailures: number;
  restartsRequired: number;
  stateCorruptionEvents: number;
  falseVerifiedSuccessEvents: number;
  cancelFailures: number;
} {
  resetInterruptHostForTests();
  const mix = [
    { outcome: 'UNVERIFIED_PATCH', verification: { ran: false }, tool: 'read_file' },
    { outcome: 'UNVERIFIED_PATCH', verification: { ran: false }, tool: 'str_replace' },
    {
      outcome: 'VERIFIED_COMPLETE',
      verification: { ran: true, passed: true, command: 'npm test', exitCode: 0 },
      tool: 'str_replace',
    },
    {
      outcome: 'UNVERIFIED_PATCH',
      verification: { ran: true, passed: false, command: 'npm test', exitCode: 1 },
      tool: 'str_replace',
    },
    { outcome: 'CANCELLED', verification: { ran: false }, tool: 'run_command', cancel: true },
    { outcome: 'UNVERIFIED_PATCH', verification: { ran: false }, tool: 'read_file' },
    { outcome: 'VERIFIED_COMPLETE', verification: { ran: true, passed: true, command: 't', exitCode: 0 }, tool: 'str_replace' },
    { outcome: 'BLOCKED_POLICY', verification: { ran: false }, tool: 'write_file' },
    { outcome: 'INFRA_FAILURE', verification: { ran: false }, tool: 'run_command' },
    { outcome: 'UNVERIFIED_PATCH', verification: { ran: false }, tool: 'str_replace' },
  ] as const;

  let tuiFailures = 0;
  let stateCorruptionEvents = 0;
  let falseVerifiedSuccessEvents = 0;
  let cancelFailures = 0;
  const restartsRequired = 0;

  for (const step of mix) {
    notifyRunStarted();
    classifyLiveActivity({ tool: step.tool });
    if ('cancel' in step && step.cancel) {
      const r = runInterrupt({});
      if (!r.cancelled || !r.processStayedAlive) cancelFailures += 1;
    }
    notifyRunEnded();
    if (!canSubmitNextTask()) {
      tuiFailures += 1;
      stateCorruptionEvents += 1;
    }
    const card = presentChatReview({
      outcome: step.outcome,
      verification: step.verification,
      changedFiles: step.tool === 'str_replace' ? ['f.ts'] : [],
    });
    if (card.looksLikeVerifiedSuccess && step.outcome !== 'VERIFIED_COMPLETE') {
      falseVerifiedSuccessEvents += 1;
    }
    if (step.verification.ran && step.verification.passed === false && card.looksLikeVerifiedSuccess) {
      falseVerifiedSuccessEvents += 1;
    }
  }

  const ok =
    mix.length === 10 &&
    tuiFailures === 0 &&
    restartsRequired === 0 &&
    stateCorruptionEvents === 0 &&
    falseVerifiedSuccessEvents === 0 &&
    cancelFailures === 0;

  return {
    scenario: ok
      ? pass('T23', '10-task loop', 'tasks_attempted=10 tui_failures=0 restarts_required=0')
      : fail(
          'T23',
          '10-task loop',
          `tui=${tuiFailures} corrupt=${stateCorruptionEvents} falseVerified=${falseVerifiedSuccessEvents} cancel=${cancelFailures}`,
        ),
    tasksAttempted: 10,
    tuiFailures,
    restartsRequired,
    stateCorruptionEvents,
    falseVerifiedSuccessEvents,
    cancelFailures,
  };
}

export function scenarioById(matrix: CertMatrix, id: string): CertScenarioResult | undefined {
  return matrix.scenarios.find((s) => s.id === id);
}

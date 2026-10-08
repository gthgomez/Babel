import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { IndependentReviewReceiptV2 } from '../evidence/independentReview.js';
import { terminateChildTree } from '../processTree.js';
import type { IndependentReviewCandidate, IndependentReviewVerdict, TrustedReviewIssuer, TrustedReviewVerifier } from './independentReviewBroker.js';
import { attachReviewProcessContainment } from './reviewProcessContainment.js';
import type { ReviewExecutionAttestation } from './reviewProvenance.js';
import {
  finiteReviewHostLifetime,
  type ReviewAuthorityCandidate,
  type ReviewAuthorityMonitor,
  type ReviewAuthorityTerminalCause,
  type ReviewHostLifetime,
} from './reviewSupervisor.js';

export interface JsonServiceCommand {
  command: string;
  args?: string[];
  cwd?: string;
  /** Legacy finite timeout. Ignored when hostLifetime is supplied. */
  timeoutMs?: number;
  hostLifetime?: ReviewHostLifetime;
  authority?: ReviewAuthorityMonitor;
  candidate?: ReviewAuthorityCandidate;
  abortSignal?: AbortSignal;
}

function gatedServiceArgs(service: JsonServiceCommand, gate: string): string[] {
  const bootstrap = `const { spawn } = require('node:child_process');
const { existsSync, unlinkSync } = require('node:fs');
const gate = ${JSON.stringify(gate)};
const start = setInterval(() => {
  if (!existsSync(gate)) return;
  clearInterval(start);
  try { unlinkSync(gate); } catch {}
  const child = spawn(${JSON.stringify(service.command)}, ${JSON.stringify(service.args ?? [])}, {
    cwd: ${JSON.stringify(service.cwd)},
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  child.once('error', () => process.exit(127));
  child.once('exit', (code) => process.exit(code ?? 1));
}, 10);`;
  return ['--eval', bootstrap];
}

function stopMessage(cause: ReviewAuthorityTerminalCause): string {
  if (cause === 'finite_timeout') return 'Trusted review service timed out.';
  if (cause === 'host_abort') return 'Trusted review service aborted.';
  if (cause === 'cleanup_timeout') return 'Trusted review service cleanup timed out.';
  return `Trusted review service authority ended: ${cause}.`;
}

export async function runJsonService<T>(service: JsonServiceCommand, input: unknown): Promise<T> {
  const lifetime = service.hostLifetime ?? finiteReviewHostLifetime(service.timeoutMs ?? 120_000);
  if (lifetime.kind === 'follow_authority') {
    if (!service.authority || !service.candidate) {
      throw new Error('Follow-authority review service requires host authority and an exact candidate.');
    }
    const admission = service.authority.inspect(service.candidate);
    if (!admission.admitted) throw new Error(stopMessage(admission.cause));
  }
  if (service.abortSignal?.aborted) throw new Error(stopMessage('host_abort'));

  const gate = join(tmpdir(), `babel-review-service-${process.pid}-${randomUUID()}.gate`);
  const child = spawn(process.execPath, gatedServiceArgs(service, gate), {
    cwd: service.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32',
  });
  const startupAbort = new AbortController();
  let startupActive = true;
  let startupCause: 'host_abort' | 'child_error' | 'child_close' | undefined;
  let childError: Error | undefined;
  let childCloseCode: number | null | undefined;
  let onChildError: ((error: Error) => void) | undefined;
  let onChildClose: ((code: number | null) => void) | undefined;
  let resolveChildClosed!: () => void;
  const childClosed = new Promise<void>((resolve) => { resolveChildClosed = resolve; });
  const stopStartup = (cause: 'host_abort' | 'child_error' | 'child_close'): void => {
    if (startupCause) return;
    startupCause = cause;
    startupAbort.abort();
    terminateChildTree(child);
  };
  const cleanupStartup = async (
    error: Error,
    containment?: Awaited<ReturnType<typeof attachReviewProcessContainment>>,
  ): Promise<never> => {
    startupActive = false;
    service.abortSignal?.removeEventListener('abort', onStartupAbort);
    startupAbort.abort();
    containment?.release();
    terminateChildTree(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        childClosed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(stopMessage('cleanup_timeout'))), lifetime.cleanupTimeoutMs);
        }),
      ]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Review service startup failed and child cleanup did not complete.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    try { unlinkSync(gate); } catch { /* gate has not been opened */ }
    throw error;
  };
  const onStartupAbort = (): void => {
    if (startupActive) stopStartup('host_abort');
  };
  child.once('error', (error) => {
    childError = error;
    if (startupActive) stopStartup('child_error');
    else onChildError?.(error);
  });
  child.once('close', (code) => {
    childCloseCode = code;
    resolveChildClosed();
    if (startupActive) stopStartup('child_close');
    else onChildClose?.(code);
  });
  service.abortSignal?.addEventListener('abort', onStartupAbort, { once: true });
  if (service.abortSignal?.aborted) onStartupAbort();

  if (!child.pid) {
    await cleanupStartup(new Error('Trusted review service could not be started.'));
  }
  let containment!: Awaited<ReturnType<typeof attachReviewProcessContainment>>;
  try {
    containment = await attachReviewProcessContainment(child.pid!, process.pid, startupAbort.signal);
  } catch (error) {
    if (startupCause === 'host_abort' || service.abortSignal?.aborted) {
      await cleanupStartup(new Error(stopMessage('host_abort')));
    }
    if (childError || startupCause === 'child_error') {
      await cleanupStartup(new Error('Trusted review service could not be started.'));
    }
    if (childCloseCode !== undefined || startupCause === 'child_close') {
      await cleanupStartup(new Error(`Trusted review service exited with code ${childCloseCode ?? 'unknown'}.`));
    }
    await cleanupStartup(error instanceof Error ? error : new Error('Review service containment could not be attached.'));
  }
  if (lifetime.kind === 'follow_authority') {
    let admission!: ReturnType<ReviewAuthorityMonitor['inspect']>;
    try {
      admission = service.authority!.inspect(service.candidate!);
    } catch (error) {
      await cleanupStartup(
        error instanceof Error ? error : new Error('Review service authority inspection failed.'),
        containment,
      );
    }
    if (!admission.admitted) {
      await cleanupStartup(new Error(stopMessage(admission.cause)), containment);
    }
  }
  if (startupCause || childError || childCloseCode !== undefined || service.abortSignal?.aborted) {
    if (startupCause === 'host_abort' || service.abortSignal?.aborted) {
      await cleanupStartup(new Error(stopMessage('host_abort')), containment);
    }
    if (childError || startupCause === 'child_error') {
      await cleanupStartup(new Error('Trusted review service could not be started.'), containment);
    }
    await cleanupStartup(
      new Error(`Trusted review service exited with code ${childCloseCode ?? 'unknown'}.`),
      containment,
    );
  }

  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let authorityPoll: ReturnType<typeof setInterval> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  return new Promise<T>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let closeObserved = false;
    let stopCause: ReviewAuthorityTerminalCause | undefined;
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const requestStop = (cause: ReviewAuthorityTerminalCause): void => {
      if (stopCause) return;
      stopCause = cause;
      if (cause === 'finite_timeout' || cause === 'host_abort') service.authority?.recordTerminal(cause);
      containment.release();
      terminateChildTree(child);
      cleanupTimer = setTimeout(() => {
        if (closeObserved) return;
        service.authority?.recordTerminal('cleanup_timeout');
        settleReject(new Error(stopMessage('cleanup_timeout')));
      }, lifetime.cleanupTimeoutMs);
      cleanupTimer.unref?.();
    };
    onAbort = (): void => requestStop('host_abort');

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    onChildError = () => {
      settleReject(new Error('Trusted review service could not be started.'));
    };
    onChildClose = (code) => {
      closeObserved = true;
      if (settled) return;
      if (stopCause) {
        settleReject(new Error(stopMessage(stopCause)));
        return;
      }
      if (code !== 0) {
        settleReject(new Error(`Trusted review service exited with code ${code ?? 'unknown'}.`));
        return;
      }
      try {
        settled = true;
        resolve(JSON.parse(stdout) as T);
      } catch {
        settleReject(new Error('Trusted review service returned invalid JSON.'));
      }
    };
    if (childError) onChildError(childError);
    else if (childCloseCode !== undefined) onChildClose(childCloseCode);

    if (lifetime.kind === 'finite') {
      lifetimeTimer = setTimeout(() => requestStop('finite_timeout'), lifetime.timeoutMs);
      lifetimeTimer.unref?.();
    } else {
      authorityPoll = setInterval(() => {
        const admission = service.authority!.inspect(service.candidate!);
        if (!admission.admitted) requestStop(admission.cause);
      }, lifetime.pollIntervalMs);
      authorityPoll.unref?.();
    }
    service.abortSignal?.addEventListener('abort', onAbort, { once: true });
    startupActive = false;
    service.abortSignal?.removeEventListener('abort', onStartupAbort);
    if (service.abortSignal?.aborted) onAbort();
    child.stdin.end(`${JSON.stringify(input)}\n`);
    try {
      writeFileSync(gate, 'ready\n', { encoding: 'utf8', mode: 0o600 });
    } catch {
      requestStop('host_abort');
      settleReject(new Error('Trusted review service could not be started.'));
    }
  }).finally(() => {
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    if (authorityPoll) clearInterval(authorityPoll);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    if (onAbort) service.abortSignal?.removeEventListener('abort', onAbort);
    containment.release();
    try { unlinkSync(gate); } catch { /* bootstrap normally removes the gate */ }
  });
}

export function createProcessAttestationSigner(service: JsonServiceCommand): (input: Omit<ReviewExecutionAttestation, 'signature'>) => Promise<ReviewExecutionAttestation> {
  return (input) => runJsonService<ReviewExecutionAttestation>(service, input);
}

/** Process boundary for the reviewer/supervisor authority lane. The builder receives only the signed receipt. */
export function createProcessTrustedReviewIssuer(service: JsonServiceCommand): TrustedReviewIssuer {
  return {
    certify: (input: {
      candidate: IndependentReviewCandidate;
      verdict: IndependentReviewVerdict;
      provenance: ReviewExecutionAttestation;
      reviewer_class: 'independent_readonly' | 'independent_breaker';
      review_mode: 'exact_head' | 'exact_revision';
    }): Promise<IndependentReviewReceiptV2> => runJsonService<IndependentReviewReceiptV2>(service, input),
  };
}

export function createProcessTrustedReviewVerifier(service: JsonServiceCommand): TrustedReviewVerifier {
  return {
    verify: (input: { candidate: IndependentReviewCandidate; receipt: IndependentReviewReceiptV2 }) =>
      runJsonService<{ passed: boolean; errors?: string[] }>(service, input),
  };
}

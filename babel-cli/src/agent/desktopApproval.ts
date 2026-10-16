import { createInterface } from 'node:readline';

import { makeRunStreamEvent, writeNdjson } from '../cli/structuredOutput.js';
import type { ApprovalRequest } from './approvalRequests.js';
import { makeDesktopApprovalBinding, matchesDesktopApprovalReply, type DesktopApprovalBinding } from './desktopApprovalBinding.js';

export type DesktopDecision = 'allow_once' | 'deny' | 'cancel';

export function desktopApprovalEnabled(): boolean {
  return process.env['BABEL_DESKTOP_IPC'] === '1';
}

/** One stdin JSON line from the Desktop window. Unknown lines deny. */
export function parseDesktopDecision(line: string): DesktopDecision {
  try {
    const value = JSON.parse(line) as { decision?: unknown };
    if (value?.decision === 'allow_once') return 'allow_once';
    if (value?.decision === 'cancel') return 'cancel';
  } catch {
    // A malformed reply denies the operation.
  }
  return 'deny';
}

export function parseDesktopApprovalLine(line: string): 'allow_once' | 'deny' {
  return parseDesktopDecision(line) === 'allow_once' ? 'allow_once' : 'deny';
}

let reader: ReturnType<typeof createInterface> | null = null;
let pending: { binding: DesktopApprovalBinding; resolve: (decision: DesktopDecision) => void; timer: ReturnType<typeof setTimeout> } | null = null;
let cancelHandler: (() => void) | null = null;

function settlePending(decision: DesktopDecision): void {
  const active = pending;
  pending = null;
  if (!active) return;
  clearTimeout(active.timer);
  active.resolve(decision);
}

/** The chat engine registers this for the life of one turn. */
export function setDesktopCancelHandler(handler: (() => void) | null): void {
  cancelHandler = handler;
}

/**
 * One readline owns stdin for the active turn. A second reader would steal
 * approval lines from the cancel line, or the reverse.
 */
export function startDesktopIpc(): void {
  if (reader || !desktopApprovalEnabled()) return;
  reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const activeReader = reader;
  reader.once('close', () => {
    if (reader !== activeReader) return;
    reader = null;
    settlePending('deny');
  });
  reader.on('line', (line) => {
    const decision = parseDesktopDecision(line);
    if (decision === 'cancel') {
      try {
        cancelHandler?.();
      } catch {
        // Cancel must not throw into the stdin reader.
      }
      settlePending('deny');
      return;
    }
    if (!pending) return;
    if (line.length > 16384) { settlePending('deny'); return; }
    let value: unknown;
    try { value = JSON.parse(line); } catch { settlePending('deny'); return; }
    if (matchesDesktopApprovalReply(value, pending.binding)) settlePending(decision);
  });
}

/** Release stdin after the turn; a closed channel can never approve work. */
export function stopDesktopIpc(): void {
  cancelHandler = null;
  settlePending('deny');
  reader?.close();
  reader = null;
}

/** Ask the Desktop window, then wait for one JSON decision on stdin. */
export async function waitForDesktopApproval(input: {
  command: string; reason: string; cwd?: string; details?: string;
  request?: Pick<ApprovalRequest, 'request_id' | 'thread_id' | 'turn_id' | 'operation_digest'>;
}): Promise<boolean> {
  if (!desktopApprovalEnabled() || !input.request) return false;
  // Never invite approval of a truncated operation preview.
  if (!input.command.trim() || [input.command, input.cwd, input.details].some(value => value !== undefined && (value.length > 250000 || value.includes('\0')))) return false;
  const binding = makeDesktopApprovalBinding(input.request, process.env['BABEL_DESKTOP_RUN_ID']);
  if (!binding) return false;
  settlePending('deny');
  startDesktopIpc();
  return new Promise((resolve) => {
    const timer = setTimeout(() => settlePending('deny'), Math.max(0, Date.parse(binding.expires_at) - Date.now()));
    timer.unref();
    pending = { binding, timer, resolve: decision => resolve(decision === 'allow_once') };
    writeNdjson(makeRunStreamEvent('approval.required', { message: input.reason, item: { command: input.command, cwd: input.cwd, details: input.details, approval: binding } }));
  });
}

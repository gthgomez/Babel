import { createInterface } from 'node:readline';

import { makeRunStreamEvent, writeNdjson } from '../cli/structuredOutput.js';

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
let pending: ((decision: DesktopDecision) => void) | null = null;
let cancelHandler: (() => void) | null = null;

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
    const resolve = pending;
    pending = null;
    resolve?.('deny');
  });
  reader.on('line', (line) => {
    const decision = parseDesktopDecision(line);
    if (decision === 'cancel') {
      try {
        cancelHandler?.();
      } catch {
        // Cancel must not throw into the stdin reader.
      }
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve('deny');
      }
      return;
    }
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(decision);
    }
  });
}

/** Release stdin after the turn; a closed channel can never approve work. */
export function stopDesktopIpc(): void {
  cancelHandler = null;
  const resolve = pending;
  pending = null;
  resolve?.('deny');
  reader?.close();
  reader = null;
}

/** Ask the Desktop window, then wait for one JSON decision on stdin. */
export async function waitForDesktopApproval(input: { command: string; reason: string }): Promise<boolean> {
  writeNdjson(
    makeRunStreamEvent('approval.required', {
      message: input.reason,
      item: { command: input.command },
    }),
  );
  startDesktopIpc();
  return new Promise((resolve) => {
    pending = (decision) => resolve(decision === 'allow_once');
  });
}

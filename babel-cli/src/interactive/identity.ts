// Session identity used to paste SOUL, AGENT_IDENTITY, CLAUDE.md, sibling-repo
// examples, and PROJECT_CONTEXT.md into the prompt. The chat stack now delivers
// the only project instructions: AGENTS.md and ENGINEERING.md, plus the
// user-wide context.md. This reader stays so existing callers keep a stable
// API, and it no longer adds a second copy of those files.

import type { IdentityDeliveredFragment } from '../agent/instructionManifest.js';
import type { ReplContext } from './context.js';

export interface SessionIdentityWithDisposition {
  systemContext: string;
  fragments: IdentityDeliveredFragment[];
}

/**
 * Project and user instructions are compiled once by `compileChatStack`.
 * This reader returns an empty disposition so a session cannot deliver
 * CLAUDE.md, a sibling example, or a second AGENTS.md.
 */
export function loadProjectSessionIdentityDispositionSync(
  _projectRoot: string,
  _workspaceRoot?: string | null,
): SessionIdentityWithDisposition {
  return { systemContext: '', fragments: [] };
}

/**
 * Async facade kept for callers that prefer a promise and for the byte-identity
 * guard in `instructionDisposition.test.ts`. It delegates to the single sync
 * reader; it is not a second implementation.
 */
export async function loadProjectSessionIdentityWithDisposition(
  projectRoot: string,
  workspaceRoot?: string | null,
): Promise<SessionIdentityWithDisposition> {
  return loadProjectSessionIdentityDispositionSync(projectRoot, workspaceRoot);
}

export async function loadProjectSessionIdentity(
  projectRoot: string,
  workspaceRoot?: string | null,
): Promise<string> {
  return loadProjectSessionIdentityDispositionSync(projectRoot, workspaceRoot).systemContext;
}

export async function loadSessionIdentity(ctx: ReplContext, projectRoot: string): Promise<string> {
  if (ctx.sessionIdentity !== null && ctx.sessionIdentityRoot === projectRoot) {
    return ctx.sessionIdentity;
  }
  ctx.sessionIdentityRoot = projectRoot;
  ctx.sessionIdentity = await loadProjectSessionIdentity(projectRoot, ctx.lastWorkspaceRoot);
  return ctx.sessionIdentity;
}

// ─── /resume Command Handler ────────────────────────────────────────────────
// Load a previously persisted conversation transcript and resume the chat
// session. Lists available sessions when called without arguments.

import type { ReplContext } from '../context.js';
import { resumeChatSession } from '../chatSessionResume.js';
import { accentBright, muted, primary, error } from '../../ui/theme.js';
import { listResumableSessions } from '../../services/chatSessionIndex.js';
import { SessionPicker } from '../../ui/sessionPicker.js';
import { OutputBuffer } from '../../ui/outputBuffer.js';

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleResume(ctx: ReplContext, args: string[]): Promise<void> {
  const sessionId = args[0];

  if (!sessionId) {
    if (process.stdout.isTTY && !process.env['CI']) {
      const sessions = await listResumableSessions({ limit: 30 });
      if (sessions.length > 0) {
        const choice = await SessionPicker.show(sessions);
        if (choice.action === 'resume') {
          await resumeSession(ctx, choice.sessionId);
        }
        return;
      }
    }
    await listSessionsText(ctx);
    return;
  }

  await resumeSession(ctx, sessionId);
}

// ─── Resume a specific session ──────────────────────────────────────────────

async function resumeSession(ctx: ReplContext, sessionId: string): Promise<void> {
  const outcome = await resumeChatSession(ctx, sessionId);
  const buf = OutputBuffer.getInstance();
  if (!outcome.ok) {
    if (outcome.reason === 'missing') {
      buf.write(error(`\n  ${outcome.message}\n`));
    } else {
      buf.write(error(`\n  Failed to resume session "${sessionId}": ${outcome.message}\n`));
    }
    return;
  }

  buf.write(
    `\n  ${accentBright('Resumed session')} ${primary(sessionId)}` +
      `\n  ${muted(`${outcome.turnCount} turns loaded (${outcome.exchangeCount} exchanges)`)}` +
      `\n  ${muted('Type a message to continue the conversation, or /clear to start fresh.')}\n`,
  );
}

async function listSessionsText(_ctx: ReplContext): Promise<void> {
  const sessions = await listResumableSessions({ limit: 30 });
  const buf = OutputBuffer.getInstance();
  if (sessions.length === 0) {
    buf.write(muted('\n  No saved chat sessions found.\n'));
    return;
  }

  buf.write(primary('\n  Saved chat sessions:\n'));
  for (const s of sessions) {
    buf.write(`    ${primary(s.id)}  ${muted(`${s.turnCount} msgs`)}  ${muted(s.preview)}\n`);
  }
  buf.write(muted('\n  Resume with: /resume <session-id>\n'));
}
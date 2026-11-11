// ─── /resume Command Handler ────────────────────────────────────────────────
// Load a previously persisted conversation transcript and resume the chat
// session. Lists available sessions when called without arguments.

import type { ReplContext } from '../context.js';
import { resumeChatSession, type ResumeChatSessionOptions } from '../chatSessionResume.js';
import { accentBright, muted, primary, error } from '../../ui/theme.js';
import { listResumableSessions } from '../../services/chatSessionIndex.js';
import { SessionPicker } from '../../ui/sessionPicker.js';
import { OutputBuffer } from '../../ui/outputBuffer.js';

// ─── Handler ────────────────────────────────────────────────────────────────

export function parseResumeArguments(args:string[]): {sessionId?:string;options:ResumeChatSessionOptions} {
  let sessionId:string | undefined;
  let executionProfile:string | undefined;
  let confirmUnknownIdentity=false;
  for(let index=0;index<args.length;index++){
    const arg=args[index]!;
    if(arg==='--confirm-repo-identity'){if(confirmUnknownIdentity)throw new Error('Duplicate identity confirmation.');confirmUnknownIdentity=true;continue;}
    if(arg==='--execution-profile'){
      if(executionProfile!==undefined||!args[index+1]||args[index+1]!.startsWith('--'))throw new Error('Provide one execution profile after --execution-profile.');
      executionProfile=args[++index];continue;
    }
    if(arg.startsWith('--')||sessionId!==undefined)throw new Error('Usage: /resume [session-id] [--execution-profile profile] [--confirm-repo-identity]');
    sessionId=arg;
  }
  return {...(sessionId!==undefined?{sessionId}:{}),options:{confirmUnknownIdentity,...(executionProfile!==undefined?{executionProfile}:{})}};
}

export async function handleResume(ctx: ReplContext, args: string[]): Promise<void> {
  let parsed:ReturnType<typeof parseResumeArguments>;
  try{parsed=parseResumeArguments(args);}catch(problem){OutputBuffer.getInstance().write(error(`\n  ${problem instanceof Error?problem.message:'Invalid resume arguments.'}\n`));return;}
  const {sessionId,options}=parsed;

  if (!sessionId) {
    if (process.stdout.isTTY && !process.env['CI']) {
      const sessions = await listResumableSessions({ limit: 30 });
      if (sessions.length > 0) {
        const adapter = ctx.rl as unknown as {
          getInputText?: () => string;
          setInputText?: (text: string) => void;
        };
        const draft = adapter.getInputText?.() ?? '';
        const { notifyOverlayClosed, notifyOverlayOpened } = await import('../../ui/interruptHost.js');
        notifyOverlayOpened(draft);
        const choice = await SessionPicker.show(sessions);
        const restored = notifyOverlayClosed();
        if (restored) adapter.setInputText?.(restored);
        if (choice.action === 'resume') {
          await resumeSession(ctx, choice.sessionId, options);
        }
        return;
      }
    }
    await listSessionsText(ctx);
    return;
  }

  await resumeSession(ctx, sessionId, options);
}

// ─── Resume a specific session ──────────────────────────────────────────────

async function resumeSession(
  ctx: ReplContext,
  sessionId: string,
  options: ResumeChatSessionOptions = {},
): Promise<void> {
  const outcome = await resumeChatSession(ctx, sessionId, options);
  const buf = OutputBuffer.getInstance();
  if (!outcome.ok) {
    if (outcome.reason === 'missing' || outcome.reason === 'cancelled') {
      buf.write(error(`\n  ${outcome.message}\n`));
    } else if (outcome.reason === 'repo_identity_unknown') {
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

import type * as readline from 'node:readline/promises';

import { dim, muted } from '../../ui/theme.js';
import { saveHistory } from '../../services/history.js';
import { InputCoordinator } from '../../ui/inputCoordinator.js';
import { dequeueComposerMessage, enqueueComposerMessage } from '../../ui/composerQueue.js';
import {
  handleInteractiveInterrupt,
  registerInterruptHost,
  unregisterInterruptHost,
} from '../../ui/interruptHost.js';
import { OutputBuffer } from '../../ui/outputBuffer.js';
import { openEditor } from '../openEditor.js';
import { handleCommand } from '../commands.js';
import type { ReplContext } from '../context.js';
import { printIdleHeader, renderTurnStatusBar } from './replSessionUi.js';

interface ReadlineWithHistory extends readline.Interface {
  history: string[];
}

export interface ReplLoopDeps {
  executeTask: (input: string) => Promise<void>;
}

function hasUnclosedBraces(line: string): boolean {
  let depth = 0;
  for (const ch of line) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
  }
  return depth > 0;
}

/** Run a task, then drain Tab-queued follow-ups (C2). */
async function executeTaskAndDrainQueue(
  ctx: ReplContext,
  deps: ReplLoopDeps,
  input: string,
): Promise<void> {
  await deps.executeTask(input);
  while (!ctx.isRunning) {
    const next = dequeueComposerMessage();
    if (!next) break;
    await deps.executeTask(next);
  }
}

async function finishReplTurn(
  ctx: ReplContext,
  coordinator: InputCoordinator,
  release: (() => void) | null,
): Promise<(() => void) | null> {
  if (!ctx.isRunning) {
    renderTurnStatusBar(ctx);
    const nextRelease = await coordinator.acquire('repl');
    ctx.rl.prompt();
    return nextRelease;
  }
  // Agent still running — keep composer active for Tab-to-queue (C2).
  ctx.rl.prompt();
  return release;
}

function getAdapterDraft(ctx: ReplContext): string {
  const adapter = ctx.rl as unknown as {
    getInputText?: () => string;
    setInputText?: (text: string) => void;
  };
  return adapter.getInputText?.() ?? '';
}

function setAdapterDraft(ctx: ReplContext, text: string): void {
  const adapter = ctx.rl as unknown as {
    setInputText?: (text: string) => void;
  };
  adapter.setInputText?.(text);
}

export async function runReplLoop(ctx: ReplContext, deps: ReplLoopDeps): Promise<void> {
  printIdleHeader(ctx);
  const coordinator = InputCoordinator.getInstance();
  let release: (() => void) | null = await coordinator.acquire('repl');

  registerInterruptHost(
    {
      cancelTurn: () => {
        ctx.chatEngine?.abortTurn();
      },
      clearComposer: () => {
        setAdapterDraft(ctx, '');
        ctx.rl.setPrompt(dim('› '));
      },
      cancelPaste: () => {
        ctx.inPaste = false;
        ctx.pasteBuffer = [];
        ctx.rl.setPrompt(dim('› '));
        OutputBuffer.getInstance().write(muted('\n  Paste cancelled.\n'));
      },
      declineOverlay: () => {
        /* overlay components close themselves; restore draft if any */
      },
      restorePrompt: () => {
        try {
          ctx.rl.prompt();
        } catch {
          /* ignore */
        }
      },
      hintExit: (message) => {
        OutputBuffer.getInstance().write(muted(`\n  ${message}\n`));
      },
      requestExit: () => {
        unregisterInterruptHost();
        ctx.exit();
      },
    },
    () => ({
      composerEmpty: getAdapterDraft(ctx).trim() === '',
      inPaste: ctx.inPaste,
      overlayActive: false,
    }),
  );

  ctx.rl.prompt();

  const consumeRelease = (): void => {
    const token = release;
    release = null;
    if (!token) return;
    try {
      token();
    } catch {
      /* already released by an overlapping line event */
    }
  };

  ctx.rl.on('line', async (line) => {
    consumeRelease();
    ctx.currentStageIdx = 0;
    const input = line.trim();

    if (line.startsWith('```') && !ctx.inPaste) {
      ctx.inPaste = true;
      ctx.pasteBuffer = [];
      ctx.rl.setPrompt(dim(`(paste: ${ctx.pasteBuffer.length} lines, Ctrl+C to cancel) ... `));
      ctx.rl.prompt();
      return;
    }

    if (ctx.inPaste) {
      if (line.trim() === '```') {
        ctx.inPaste = false;
        ctx.rl.setPrompt(dim('› '));
        const fullInput = ctx.pasteBuffer.join('\n').trim();
        ctx.pasteBuffer = [];
        if (!fullInput) {
          release = await coordinator.acquire('repl');
          ctx.rl.prompt();
          return;
        }
        saveHistory((ctx.rl as ReadlineWithHistory).history);
        await executeTaskAndDrainQueue(ctx, deps, fullInput);
        release = await finishReplTurn(ctx, coordinator, release);
        return;
      }
      ctx.pasteBuffer.push(line);
      ctx.rl.setPrompt(dim(`(paste: ${ctx.pasteBuffer.length} lines, Ctrl+C to cancel) ... `));
      ctx.rl.prompt();
      return;
    }

    if (hasUnclosedBraces(input)) {
      ctx.inPaste = true;
      ctx.pasteBuffer = [line];
      ctx.rl.setPrompt(dim(`(paste: ${ctx.pasteBuffer.length} lines, Ctrl+C to cancel) ... `));
      ctx.rl.prompt();
      return;
    }

    if (input === '.editor') {
      const edited = await openEditor({ rl: ctx.rl });
      if (edited) {
        saveHistory((ctx.rl as ReadlineWithHistory).history);
        await executeTaskAndDrainQueue(ctx, deps, edited.trim());
        release = await finishReplTurn(ctx, coordinator, release);
      } else {
        release = await coordinator.acquire('repl');
        ctx.rl.prompt();
      }
      return;
    }

    if (!input) {
      release = await coordinator.acquire('repl');
      ctx.rl.prompt();
      return;
    }

    // Agent busy: queue follow-up instead of parallel execution (C2).
    if (ctx.isRunning && !input.startsWith('/')) {
      enqueueComposerMessage(input);
      ctx.rl.prompt();
      return;
    }

    saveHistory((ctx.rl as ReadlineWithHistory).history);

    if (input.startsWith('/')) {
      await handleCommand(ctx, input);
      release = await finishReplTurn(ctx, coordinator, release);
    } else {
      await executeTaskAndDrainQueue(ctx, deps, input);
      release = await finishReplTurn(ctx, coordinator, release);
    }
  });

  ctx.rl.on('SIGINT', () => {
    handleInteractiveInterrupt({
      composerEmpty: getAdapterDraft(ctx).trim() === '',
      inPaste: ctx.inPaste,
    });
  });
}
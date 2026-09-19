/**
 * Executor for real shell selection commands.
 *
 * `runShellCommand` is the pure dispatch seam (unit-testable with injected
 * operations). `createShellCommandOperations` is the production wiring that
 * reuses existing ReplContext handlers — it re-implements no command.
 *
 * Async work is expected to be wrapped by the caller in the host's exclusive
 * terminal lease (BabelRepl.withExclusiveTerminal), matching the existing
 * palette/reverse-search path.
 */

import type { ReplContext } from '../../interactive/context.js'
import { resumeChatSession } from '../../interactive/chatSessionResume.js'
import { handleClear, handleRetarget } from '../../interactive/commands/config.js'
import { handleCommand } from '../../interactive/commands.js'
import type { ShellCommand } from './shellNavigation.js'

export interface ShellResumeResult {
  readonly ok: boolean
  readonly message?: string
}

/** Real operations an activation can perform. */
export interface ShellCommandOperations {
  resumeSession(id: string): Promise<ShellResumeResult>
  newSession(): void
  setTarget(root: string): void
  runAction(command: string): Promise<void>
  toggleInspector(key: string): void
}

export interface ShellOperationOutcome {
  readonly command: ShellCommand['kind']
  readonly handled: boolean
  readonly message?: string
}

/** Dispatch one already-resolved shell command to its real operation. */
export async function runShellCommand(
  command: ShellCommand,
  operations: ShellCommandOperations,
): Promise<ShellOperationOutcome> {
  switch (command.kind) {
    case 'session.resume': {
      const result = await operations.resumeSession(command.id)
      return {
        command: command.kind,
        handled: result.ok,
        ...(result.message !== undefined ? { message: result.message } : {}),
      }
    }
    case 'session.new':
      operations.newSession()
      return { command: command.kind, handled: true }
    case 'target.set':
      operations.setTarget(command.root)
      return { command: command.kind, handled: true }
    case 'action.run':
      await operations.runAction(command.command)
      return { command: command.kind, handled: true }
    case 'inspector.toggle':
      operations.toggleInspector(command.key)
      return { command: command.kind, handled: true }
    case 'none':
      return { command: command.kind, handled: false, message: command.reason }
    default: {
      const exhaustive: never = command
      return { command: 'none', handled: false, message: String(exhaustive) }
    }
  }
}

export interface ShellOperationHost {
  readonly invalidate: (reason: string) => void
  /** Rebind the presentation runtime after the active thread changes. */
  readonly onSessionChanged: (threadId: string | undefined) => void
}

/** Production operations wired to existing ReplContext handlers. */
export function createShellCommandOperations(
  ctx: ReplContext,
  host: ShellOperationHost,
): ShellCommandOperations {
  return {
    async resumeSession(id: string): Promise<ShellResumeResult> {
      const outcome = await resumeChatSession(ctx, id)
      if (outcome.ok) {
        host.onSessionChanged(ctx.chatEngine?.getEngineRunId() ?? id)
        return { ok: true }
      }
      return { ok: false, message: outcome.message }
    },
    newSession(): void {
      handleClear(ctx, [])
      host.onSessionChanged(undefined)
    },
    setTarget(root: string): void {
      handleRetarget(ctx, [root])
      host.onSessionChanged(undefined)
    },
    async runAction(command: string): Promise<void> {
      await handleCommand(ctx, command)
    },
    toggleInspector(): void {
      host.invalidate('inspector-toggle')
    },
  }
}

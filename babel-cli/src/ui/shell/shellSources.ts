/**
 * Real, existing-backed source projections for the hosted North Star shell.
 *
 * Every row here comes from an existing runtime source:
 *  - sessions  → `listResumableSessions` (chatSessionIndex)
 *  - project   → `readShallowTargetListing` (targetResolver)
 *  - actions   → `BUILTIN_SLASH_COMMANDS` (typeaheadEngine)
 *
 * There is no second database and no fabricated row. Missing data surfaces as
 * an explicit empty/error/unknown state. These adapters are the only place the
 * shell touches those APIs; retire them through the existing deletion plan when
 * the full P15 runtime projection converges.
 *
 * The project listing is cached per target root so the render path does not
 * probe the filesystem on every frame (U02).
 */

import { join } from 'node:path'

import {
  listResumableSessions,
  type ChatSessionInfo,
} from '../../services/chatSessionIndex.js'
import { readShallowTargetListing } from '../../services/targetResolver.js'
import { BUILTIN_SLASH_COMMANDS, type SlashCommand } from '../typeaheadEngine.js'
import type { ShellNavigationRow } from './shellNavigation.js'

/** Slash commands that are safe and meaningful to run from the shell panel. */
export const SHELL_ACTION_COMMANDS: readonly string[] = [
  '/resume',
  '/model',
  '/mode',
  '/project',
  '/diff',
  '/review',
  '/status',
  '/doctor',
  '/theme',
  '/help',
]

/** Build the QUICK ACTIONS rows from the shared slash-command catalog. */
export function loadShellActionRows(
  commands: readonly SlashCommand[] = BUILTIN_SLASH_COMMANDS,
): ShellNavigationRow[] {
  const rows: ShellNavigationRow[] = [{ id: '/clear', label: 'New conversation', command: { kind: 'session.new' } }]
  for (const command of commands) {
    if (!SHELL_ACTION_COMMANDS.includes(command.name)) continue
    rows.push({
      id: command.name,
      label: `${command.name}  ${command.description}`,
      command: { kind: 'action.run', command: command.name },
    })
  }
  return rows
}

/** Map a shallow directory listing to selectable project rows (lazily listed). */
export function loadShellProjectRows(
  targetRoot: string,
  list: (root: string, limit?: number) => string[] = readShallowTargetListing,
): ShellNavigationRow[] {
  return list(targetRoot)
    .map((entry): ShellNavigationRow | null => {
      const match = /^\[(dir|file)\] (.+)$/.exec(entry)
      if (!match) return { id: entry, label: entry }
      const [, kind, name] = match
      const fullPath = join(targetRoot, name!)
      if (kind === 'dir') {
        return {
          id: fullPath,
          label: `[dir] ${name}`,
          command: { kind: 'target.set', root: fullPath },
        }
      }
      return { id: fullPath, label: `[file] ${name}` }
    })
    .filter((row): row is ShellNavigationRow => row !== null)
}

/** Map real saved sessions to selectable resume rows. */
export function mapShellSessionRows(sessions: readonly ChatSessionInfo[]): ShellNavigationRow[] {
  return sessions.map((session) => {
    const preview = session.preview.trim() || '(no preview)'
    return {
      id: session.id,
      label: `${preview}  (${session.turnCount} msgs)`,
      command: { kind: 'session.resume', id: session.id },
    }
  })
}

export type ShellSessionStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface ShellSourcesSnapshot {
  readonly sessions: readonly ShellNavigationRow[]
  readonly sessionStatus: ShellSessionStatus
  readonly sessionError?: string
  readonly projectRoot: string
  readonly projectRows: readonly ShellNavigationRow[]
  readonly actions: readonly ShellNavigationRow[]
}

type SessionLoader = (options?: { limit?: number }) => Promise<ChatSessionInfo[]>
type ProjectLister = (root: string, limit?: number) => string[]

/**
 * Small cache around the real sources. Sessions are loaded asynchronously and
 * refreshed on demand; the project listing is refreshed only when the target
 * root changes.
 */
export class ShellSources {
  private sessionRows: readonly ShellNavigationRow[] = []
  private sessionStatus: ShellSessionStatus = 'loading'
  private sessionError: string | undefined
  private projectRoot = ''
  private projectRows: readonly ShellNavigationRow[] = []
  private readonly actions: readonly ShellNavigationRow[]

  constructor(
    private readonly loadSessions: SessionLoader = listResumableSessions,
    private readonly listProject: ProjectLister = readShallowTargetListing,
  ) {
    this.actions = loadShellActionRows()
  }

  async refreshSessions(limit = 30): Promise<void> {
    this.sessionStatus = 'loading'
    try {
      const sessions = await this.loadSessions({ limit })
      this.sessionRows = mapShellSessionRows(sessions)
      this.sessionStatus = sessions.length > 0 ? 'ready' : 'empty'
      this.sessionError = undefined
    } catch (error) {
      this.sessionRows = []
      this.sessionStatus = 'error'
      this.sessionError = error instanceof Error ? error.message : String(error)
    }
  }

  /** Re-list the target only when it changed; avoids per-frame filesystem I/O. */
  ensureProjectRoot(targetRoot: string): void {
    if (targetRoot === this.projectRoot) return
    this.projectRoot = targetRoot
    this.projectRows = loadShellProjectRows(targetRoot, this.listProject)
  }

  snapshot(): ShellSourcesSnapshot {
    return {
      sessions: this.sessionRows,
      sessionStatus: this.sessionStatus,
      ...(this.sessionError !== undefined ? { sessionError: this.sessionError } : {}),
      projectRoot: this.projectRoot,
      projectRows: this.projectRows,
      actions: this.actions,
    }
  }
}

/**
 * Format TUI observation for humans and agents.
 * Never echoes raw ANSI / CSI to the calling terminal.
 * latest.txt is the virtual cell grid, not turnViewProjector output.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { BABEL_RUNS_DIR } from '../../cli/constants.js'
import { loadSessionEventLogFromDir } from '../../agent/sessionEvents.js'
import {
  loadLatestTuiFrame,
  loadSessionsLatestPointer,
  type TuiFrameBundle,
} from './tuiSessionStore.js'
import { reduceObservationSemantic, type ObservationSemanticState } from './observationSemantic.js'

export type InspectTuiView = 'screen' | 'semantic' | 'both' | 'diff'

/**
 * Resolve a run dir or tui-session dir to a session observation directory.
 *
 * @param path Run dir, tui-session dir, or latest
 */
export function resolveTuiSessionDir(path: string): string {
  const ref = join(path, 'tui-session-ref.json')
  if (existsSync(ref)) {
    const parsed = JSON.parse(readFileSync(ref, 'utf8')) as { sessionDir?: string }
    if (parsed.sessionDir && existsSync(parsed.sessionDir)) return parsed.sessionDir
  }
  if (existsSync(join(path, 'latest.json'))) return path
  const nested = join(path, 'tui')
  if (existsSync(join(nested, 'latest.json'))) return nested
  return path
}

/**
 * Resolve inspect tui path argument.
 *
 * @param pathArg CLI argument
 */
export function resolveInspectTuiPath(pathArg: string | undefined): string {
  if (!pathArg || pathArg === 'latest') {
    return loadSessionsLatestPointer(join(BABEL_RUNS_DIR, 'tui-sessions')) ?? join(BABEL_RUNS_DIR, 'tui-sessions')
  }
  return resolveTuiSessionDir(pathArg)
}

/**
 * Render inspect tui output from an atomic latest pointer.
 *
 * @param sessionDir Observation session directory
 * @param view screen | semantic | both | diff
 */
export function formatInspectTui(sessionDir: string, view: InspectTuiView = 'both'): string {
  const bundle = loadLatestTuiFrame(sessionDir)
  if (bundle) {
    if (view === 'screen') return formatScreen(bundle)
    if (view === 'semantic') return formatSemantic(bundle)
    if (view === 'diff') return formatDiff(bundle)
    return `${formatSemantic(bundle)}\n${formatScreen(bundle)}`
  }
  const semanticOnly = formatSemanticOnlyFromRun(sessionDir)
  if (semanticOnly) {
    if (view === 'screen') {
      return 'SCREEN unavailable. No renderer stream was recorded; refusing to reconstruct a terminal from ChatEngine/projector state.\n'
    }
    return semanticOnly
  }
  return 'No TUI observation frames. Enable BABEL_TUI_OBSERVE=1 on an interactive session.\n'
}

/**
 * Attach `inspect tui` under the existing inspect command.
 *
 * @param inspectCommand Commander inspect parent
 */
export function registerInspectTuiCommand(inspectCommand: Command): void {
  inspectCommand
    .command('tui')
    .description('Inspect the recorded TUI observation (virtual cell grid + semantics, not a projector dump)')
    .argument('[path]', 'tui-session dir, chat run dir, or latest')
    .option('--view <view>', 'screen | semantic | both | diff', 'both')
    .addHelpText(
      'after',
      `
Notes:
  - latest.txt is the virtual terminal cell grid derived from actual stdout bytes.
  - latest.semantic.json is the semantic oracle (tools, stall, mutations).
  - These are independent truths. Agreement is high confidence; disagreement localizes the bug.
  - BABEL_A11Y and turnViewProjector are not the visual screen.
`,
    )
    .action((pathArg: string | undefined, options: { view?: string }) => {
      const view = normalizeView(options.view)
      const dir = resolveInspectTuiPath(pathArg)
      process.stdout.write(formatInspectTui(dir, view))
    })
}

function normalizeView(raw: string | undefined): InspectTuiView {
  if (raw === 'screen' || raw === 'semantic' || raw === 'both' || raw === 'diff') return raw
  return 'both'
}

function formatScreen(bundle: TuiFrameBundle): string {
  const { watermarks, screen } = bundle
  const header = `FRAME ${watermarks.frameId}  SIZE ${watermarks.geometry.cols}x${watermarks.geometry.rows}  CURSOR ${screen.cursorRow},${screen.cursorCol}`
  const body = screen.lines.map((line, i) => `${String(i).padStart(2, ' ')}|${sanitizePlain(line)}`).join('\n')
  return `${header}\n${body}\n`
}

function formatSemanticState(s: ObservationSemanticState, frameId: number | string): string {
  const tool = s.lastTool
    ? `${s.lastTool.name} ${s.lastTool.state}${s.lastTool.target ? ` ${s.lastTool.target}` : ''}`
    : 'none'
  const proj = s.projection
    ? `  projection review=${s.projection.reviewStatus} status_label=${s.projection.statusLabel} terminal=${s.projection.isTerminal}`
    : '  projection=(none)'
  return [
    `SEMANTIC  frame=${frameId} seq=${s.semanticEventSeq} turn=${s.turnId ?? '-'}`,
    `  status=${s.terminalStatus} stall_cycle=${s.stallCycle} recovery=${s.progressRecoveryCount}`,
    `  last_tool=${tool}`,
    `  tools attempts=${s.toolAttempts} completed=${s.toolCompleted} failed=${s.toolFailed} blocked=${s.toolBlocked}`,
    `  workspace_mutation_count=${s.workspaceMutationCount}`,
    proj,
    '',
  ].join('\n')
}

function formatSemantic(bundle: TuiFrameBundle): string {
  const s = bundle.semantic
  if (!s) return 'SEMANTIC  (none bound to this frame)\n'
  return formatSemanticState(s, bundle.watermarks.frameId)
}

function formatSemanticOnlyFromRun(runDir: string): string | null {
  const log = loadSessionEventLogFromDir(runDir)
  if (!log || log.events.length === 0) return null
  const s = reduceObservationSemantic(log.events)
  return [
    'SCREEN unavailable (no renderer stream recorded; this is semantic-only, not visual evidence).',
    formatSemanticState(s, 'none'),
  ].join('\n')
}

function formatDiff(bundle: TuiFrameBundle): string {
  const s = bundle.semantic
  if (!s) return formatScreen(bundle)
  const bound = s.semanticEventSeq === bundle.watermarks.semanticEventSeq
  if (!bound) {
    return 'REFUSED: semantic_event_seq is not bound to this render (would be a torn comparison).\n'
  }
  const statusOnScreen = bundle.screen.lines.some((l) =>
    /stall|blocked|running|complete/i.test(l),
  )
  return `${formatSemantic(bundle)}bound=${bound} screen_mentions_status=${statusOnScreen}\n${formatScreen(bundle)}`
}

function sanitizePlain(line: string): string {
  return line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '')
}

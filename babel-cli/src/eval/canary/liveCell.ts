/**
 * Live ChatEngine canary cell: isolated workspace + chat-headless + clean-room grade.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BABEL_ROOT } from '../../cli/constants.js'
import { resolveBabelCliEntry, runBabelCli } from '../../services/liteTrustDemo.js'
import { gradeInCleanRoom, type CleanRoomFile } from '../cleanRoomGrade.js'
import type { CanaryTaskSpec } from './types.js'

const LIVE_AGENT_TIMEOUT_MS = 10 * 60 * 1000

export interface LiveCellLaunch {
  model: string
  workspaceRoot: string
  evidencePath: string
}

export interface LiveCellOutcome {
  status: string | null
  claimed_complete: boolean
  honest_block: boolean
  tokens: number | null
  cost_usd: number | null
  production_files: CleanRoomFile[]
  deleted_production_paths: string[]
  production_mutated: boolean
  hidden_ok: boolean
  visible_ok: boolean | null
  stdout_tail: string
  notes: string[]
  run_dir: string | null
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'babel-canary',
    GIT_AUTHOR_EMAIL: 'babel-canary@local',
    GIT_COMMITTER_NAME: 'babel-canary',
    GIT_COMMITTER_EMAIL: 'babel-canary@local',
  }
}

export function materializeCanaryWorkspace(spec: CanaryTaskSpec, root: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: `canary-${spec.id.toLowerCase()}`, type: 'module', private: true }, null, 2)}\n`,
  )
  writeFileSync(join(root, 'README.md'), `# ${spec.id}\n\n${spec.prompt}\n`)
  for (const file of spec.files) {
    const full = join(root, file.relativePath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, file.start, 'utf8')
  }
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' })
  spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8', env: gitEnv() })
  spawnSync('git', ['commit', '-m', `canary ${spec.id} start`], {
    cwd: root,
    encoding: 'utf8',
    env: gitEnv(),
  })
}

function startFiles(spec: CanaryTaskSpec): CleanRoomFile[] {
  return spec.files.map((f) => ({ relativePath: f.relativePath, contents: f.start }))
}

function oracleFiles(spec: CanaryTaskSpec): CleanRoomFile[] {
  return [{ relativePath: 'hidden.test.mjs', contents: spec.oracle_test }]
}

/**
 * Faithful production-state capture for a canary workspace.
 *
 * - `files`: production paths present on disk (contents may equal start)
 * - `deletedPaths`: declared production paths the agent REMOVED
 *
 * A deletion must never silently vanish from the candidate representation:
 * the clean-room baseline would otherwise resurrect the file and could score
 * destructive edits as success.
 */
export interface ProductionStateCapture {
  files: CleanRoomFile[]
  deletedPaths: string[]
}

export function captureProductionState(
  spec: CanaryTaskSpec,
  root: string,
): ProductionStateCapture {
  const files: CleanRoomFile[] = []
  const deletedPaths: string[] = []
  for (const rel of spec.production_paths) {
    const full = join(root, rel)
    if (!existsSync(full)) {
      deletedPaths.push(rel)
      continue
    }
    files.push({ relativePath: rel, contents: readFileSync(full, 'utf8') })
  }
  return { files, deletedPaths }
}

function usageFromPayload(payload: Record<string, unknown> | null): {
  tokens: number | null
  cost_usd: number | null
} {
  if (!payload) return { tokens: null, cost_usd: null }
  const usage =
    payload['usage'] !== null && typeof payload['usage'] === 'object'
      ? (payload['usage'] as Record<string, unknown>)
      : null
  if (!usage) return { tokens: null, cost_usd: null }
  return {
    tokens: typeof usage['totalTokens'] === 'number' ? usage['totalTokens'] : null,
    cost_usd: typeof usage['totalCostUSD'] === 'number' ? usage['totalCostUSD'] : null,
  }
}

/**
 * Drive Babel ChatEngine (chat-headless) against an isolated canary workspace.
 */
export function runLiveCanaryCell(input: {
  spec: CanaryTaskSpec
  workspaceRoot: string
  model: string
  evidencePath: string
}): LiveCellOutcome {
  const notes: string[] = []
  const prompt = [
    input.spec.prompt,
    'Work only in this project root. Edit production source if needed.',
    'Do not create hidden tests. Do not invent missing proprietary binaries.',
  ].join('\n')
  const cli = runBabelCli(
    [
      'run',
      '--mode',
      'chat-headless',
      '--model',
      input.model,
      '--json',
      '--yes',
      '--project-root',
      input.workspaceRoot,
      prompt,
    ],
    {
      projectRoot: input.workspaceRoot,
      offlineDemo: false,
      cliEntry: resolveBabelCliEntry(),
      cwd: join(BABEL_ROOT, 'babel-cli'),
      timeoutMs: LIVE_AGENT_TIMEOUT_MS,
      ensureDist: true,
      env: {
        BABEL_ROOT,
      },
    },
  )
  writeFileSync(
    input.evidencePath,
    JSON.stringify(
      {
        exitCode: cli.exitCode,
        timedOut: cli.timedOut ?? false,
        payload: cli.payload,
        stdout_tail: (cli.stdout ?? '').slice(-4000),
        stderr_tail: (cli.stderr ?? '').slice(-4000),
      },
      null,
      2,
    ),
  )
  const payload = cli.payload
  const status = typeof payload?.['status'] === 'string' ? payload['status'] : null
  const claimed_complete =
    status === 'ANSWER_READY' || status === 'FIX_COMPLETE' || status === 'COMPLETE'
  const honest_block = status === 'BLOCKED' || Boolean(payload?.['blocked_report'])
  const productionState = captureProductionState(input.spec, input.workspaceRoot)
  const production_files = productionState.files
  // A deletion IS a mutation — a removed production path must never be
  // classified as "unchanged" for NO_CHANGE_REQUIRED-style contracts.
  const production_mutated =
    production_files.some((f) => {
      const start = input.spec.files.find((s) => s.relativePath === f.relativePath)?.start
      return start !== f.contents
    }) || productionState.deletedPaths.length > 0
  const candidateChanged = production_files.filter((f) => {
    const start = input.spec.files.find((s) => s.relativePath === f.relativePath)?.start
    return start !== f.contents
  })
  const grade = gradeInCleanRoom({
    startFiles: startFiles(input.spec),
    candidateDiffFiles: candidateChanged,
    candidateDeletedPaths: productionState.deletedPaths,
    oracleFiles: oracleFiles(input.spec),
    verifierCommand: [process.execPath, 'hidden.test.mjs'],
  })
  let visible_ok: boolean | null = null
  if (input.spec.visible_test) {
    visible_ok = gradeInCleanRoom({
      startFiles: startFiles(input.spec),
      candidateDiffFiles: candidateChanged,
      candidateDeletedPaths: productionState.deletedPaths,
      oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: input.spec.visible_test }],
      verifierCommand: [process.execPath, 'hidden.test.mjs'],
    }).hidden_ok
  }
  const usage = usageFromPayload(payload)
  if (cli.timedOut) notes.push('harness_timeout')
  notes.push(`cli_exit=${cli.exitCode}`, `status=${status ?? 'null'}`)
  if (productionState.deletedPaths.length > 0) {
    notes.push(`deleted=${productionState.deletedPaths.join(',')}`)
  }
  const run_dir = typeof payload?.['run_dir'] === 'string' ? payload['run_dir'] : null
  return {
    status,
    claimed_complete,
    honest_block,
    tokens: usage.tokens,
    cost_usd: usage.cost_usd,
    production_files,
    deleted_production_paths: productionState.deletedPaths,
    production_mutated,
    hidden_ok: grade.hidden_ok,
    visible_ok,
    stdout_tail: (cli.stdout ?? '').slice(-500),
    notes,
    run_dir,
  }
}

export const LIVE_CANARY_DEFAULT_MODEL = 'deepseek-v4-flash'

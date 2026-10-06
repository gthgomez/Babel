/**
 * Grade a candidate production diff in a fresh verifier workspace.
 * Agent-mutated trees are never the grader tree.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildBenchmarkContainerCommand, isHostIsolationEscalationAllowed } from '../config/benchmarkContainer.js'
import { validateDockerIsolationArgs } from '../config/dockerIsolationArgs.js'

export interface CleanRoomFile {
  relativePath: string
  contents: string
}

export interface CleanRoomGradeInput {
  startFiles: CleanRoomFile[]
  /** Production paths only (never oracle files). */
  candidateDiffFiles: CleanRoomFile[]
  /**
   * Production paths the candidate DELETED relative to startFiles. Applied
   * after every write so the graded tree faithfully reproduces the candidate's
   * state — without this, the clean-room baseline would resurrect a file the
   * agent removed and could score destructive edits as success.
   */
  candidateDeletedPaths?: string[]
  oracleFiles: CleanRoomFile[]
  verifierCommand: string[]
  cwdHint?: string
  /** Explicit isolated candidate grading; omission preserves trusted host controls. */
  execution?: { kind: 'docker'; image: string }
}

export interface CleanRoomGradeResult {
  hidden_ok: boolean
  exit_code: number
  stdout: string
  stderr: string
  grader_root: string
  verifier_command: string[]
  /** Deletion paths actually enforced in the graded tree (evidence). */
  deletions_applied: string[]
  /** Present only for an explicitly selected isolated execution boundary. */
  execution_boundary?: { kind: 'docker'; image: string }
  execution_command?: string[]
}

function materialize(root: string, files: CleanRoomFile[]): void {
  for (const file of files) {
    const full = join(root, file.relativePath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, file.contents, 'utf8')
  }
}

/**
 * Fresh start SHA + production diff + private oracle + harness-owned verifier.
 */
export function gradeInCleanRoom(input: CleanRoomGradeInput): CleanRoomGradeResult {
  if (input.execution !== undefined) {
    if (input.execution?.kind !== 'docker' ||
        !/^[a-zA-Z0-9._/:+-]+@sha256:[a-f0-9]{64}$/.test(input.execution.image) ||
        input.verifierCommand[0] !== 'node' ||
        input.verifierCommand.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg)) ||
        isHostIsolationEscalationAllowed() || !validateDockerIsolationArgs().ok) {
      throw new Error('Isolated grader requires a pinned Docker image, in-container node argv and no host fallback.')
    }
  }
  const deletedPaths = input.candidateDeletedPaths ?? []
  const candidatePaths = new Set(input.candidateDiffFiles.map((f) => f.relativePath))
  const conflicted = deletedPaths.filter((p) => candidatePaths.has(p))
  if (conflicted.length > 0) {
    throw new Error(
      `clean-room grader integrity: path(s) both captured and marked deleted: ${conflicted.join(', ')}`,
    )
  }
  const graderRoot = join(input.cwdHint ?? tmpdir(), `babel-cleanroom-${randomUUID()}`)
  mkdirSync(graderRoot, { recursive: true })
  try {
    materialize(graderRoot, input.startFiles)
    materialize(graderRoot, input.candidateDiffFiles)
    materialize(graderRoot, input.oracleFiles)
    // Enforce deletions LAST — after baseline resurrection — so the graded
    // tree matches the candidate's real production state.
    for (const rel of deletedPaths) {
      rmSync(join(graderRoot, rel), { force: true, recursive: true })
    }
    const [cmd, ...args] = input.verifierCommand
    const container = input.execution ? buildBenchmarkContainerCommand({
      dockerImage: input.execution.image,
      projectRoot: graderRoot,
      cwd: graderRoot,
      // Build only the existing hardened prefix; append trusted argv directly.
      // No shell parsing or host executable path enters isolated grading.
      command: 'node',
    }) : null
    const executable = container?.executable ?? cmd ?? process.execPath
    const executionArgs = container ? [...container.args, ...args] : args
    const result = spawnSync(executable, executionArgs, {
      cwd: graderRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const exit = typeof result.status === 'number' ? result.status : 1
    return {
      hidden_ok: exit === 0,
      exit_code: exit,
      stdout,
      stderr,
      grader_root: graderRoot,
      verifier_command: input.verifierCommand,
      deletions_applied: [...deletedPaths],
      ...(input.execution ? { execution_boundary: { ...input.execution },
        execution_command: [executable, ...executionArgs] } : {}),
    }
  } finally {
    if (existsSync(graderRoot)) {
      rmSync(graderRoot, { recursive: true, force: true })
    }
  }
}

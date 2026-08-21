/**
 * Grade a candidate production diff in a fresh verifier workspace.
 * Agent-mutated trees are never the grader tree.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

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
    const result = spawnSync(cmd ?? process.execPath, args, {
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
    }
  } finally {
    if (existsSync(graderRoot)) {
      rmSync(graderRoot, { recursive: true, force: true })
    }
  }
}

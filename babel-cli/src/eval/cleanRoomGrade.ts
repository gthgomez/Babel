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
  const graderRoot = join(input.cwdHint ?? tmpdir(), `babel-cleanroom-${randomUUID()}`)
  mkdirSync(graderRoot, { recursive: true })
  try {
    materialize(graderRoot, input.startFiles)
    materialize(graderRoot, input.candidateDiffFiles)
    materialize(graderRoot, input.oracleFiles)
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
    }
  } finally {
    if (existsSync(graderRoot)) {
      rmSync(graderRoot, { recursive: true, force: true })
    }
  }
}

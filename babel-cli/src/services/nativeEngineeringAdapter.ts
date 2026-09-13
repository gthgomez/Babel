import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AutonomousEngineeringWorkerAdapter,
  AutonomousRepairResult,
  IndependentReviewExecutionRequest,
  IndependentReviewExecutionResult,
} from './independentReviewController.js'

export interface IsolatedWorktreeAdapterOptions {
  adapter_id: string
  agent_kind: string
  repoRoot: string
  worktreeBaseDir?: string
  workerCommandRunner?: (worktreeDir: string, request: IndependentReviewExecutionRequest) => Promise<{
    verdict?: 'APPROVE' | 'BLOCK'
    findings?: string[]
    blocking_findings?: string[]
    modified?: boolean
    commit_message?: string
  }>
}

/**
 * Stage 2 Native Engineering Adapter:
 * Executes review and repair operations inside isolated git worktrees rather than
 * mutating the host orchestrator repository.
 */
export function createIsolatedWorktreeEngineeringAdapter(
  options: IsolatedWorktreeAdapterOptions
): AutonomousEngineeringWorkerAdapter {
  const baseDir = options.worktreeBaseDir ?? tmpdir()

  return {
    adapter_id: options.adapter_id,
    agent_kind: options.agent_kind,

    async launch(request: Readonly<IndependentReviewExecutionRequest>): Promise<IndependentReviewExecutionResult> {
      if (!options.workerCommandRunner) {
        throw new Error('AUTONOMOUS_REVIEW_RUNNER_REQUIRED')
      }

      const runId = request.controller_run_id || randomUUID()
      const worktreeDir = join(baseDir, `babel-wt-rev-${runId}-${Date.now()}`)
      const purpose = request.purpose ?? 'FINAL_CERTIFICATION'

      try {
        // 1. Create isolated git worktree detached at candidate head_sha
        execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, request.candidate.head_sha], {
          cwd: options.repoRoot,
          stdio: 'pipe',
          windowsHide: true,
        })

        // 2. Write task context inside worktree
        const candidateDigest = 'candidate_digest' in request.candidate ? request.candidate.candidate_digest : undefined
        const contextPayload = {
          candidate_digest: candidateDigest,
          base_sha: request.candidate.base_sha,
          head_sha: request.candidate.head_sha,
          scope: request.candidate.scope,
          purpose,
          reviewer: request.reviewer,
        }
        writeFileSync(join(worktreeDir, '.babel-task-context.json'), JSON.stringify(contextPayload, null, 2))

        // 3. Execute worker
        const workerResult = await options.workerCommandRunner(worktreeDir, request)

        const verdict = workerResult.verdict ?? 'BLOCK'
        return {
          status: 'COMPLETED',
          verdict,
          findings: workerResult.findings ?? [],
          blocking_findings: workerResult.blocking_findings ?? [],
          reviewed_at: new Date().toISOString(),
          scope: [...request.candidate.scope],
          isolation: request.required_isolation,
          execution_purpose: purpose,
          runtime: {
            agent_kind: options.agent_kind,
            adapter_id: options.adapter_id,
            controller_execution_id: request.reviewer.execution_id,
            execution_purpose: purpose,
          },
        }
      } finally {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], {
            cwd: options.repoRoot,
            stdio: 'pipe',
            windowsHide: true,
          })
        } catch {
          if (existsSync(worktreeDir)) {
            rmSync(worktreeDir, { recursive: true, force: true })
          }
        }
      }
    },

    async repair(request: Readonly<IndependentReviewExecutionRequest>): Promise<AutonomousRepairResult> {
      if (!options.workerCommandRunner) {
        throw new Error('AUTONOMOUS_REPAIR_RUNNER_REQUIRED')
      }

      const runId = request.controller_run_id || randomUUID()
      const branchName = `babel-repair-${runId}-${Date.now()}`
      const worktreeDir = join(baseDir, `babel-wt-rep-${runId}-${Date.now()}`)

      try {
        // 1. Create isolated git worktree on unique branch at candidate head_sha
        execFileSync('git', ['worktree', 'add', '-b', branchName, worktreeDir, request.candidate.head_sha], {
          cwd: options.repoRoot,
          stdio: 'pipe',
          windowsHide: true,
        })

        // 2. Write candidate metadata / task context
        const candidateDigest = 'candidate_digest' in request.candidate ? request.candidate.candidate_digest : undefined
        const contextPayload = {
          candidate_digest: candidateDigest,
          base_sha: request.candidate.base_sha,
          head_sha: request.candidate.head_sha,
          scope: request.candidate.scope,
          purpose: 'REVIEW_REPAIR',
          repair_branch: branchName,
          reviewer: request.reviewer,
        }
        writeFileSync(join(worktreeDir, '.babel-task-context.json'), JSON.stringify(contextPayload, null, 2))

        // 3. Execute worker
        const workerResult = await options.workerCommandRunner(worktreeDir, request)

        if (!workerResult.modified) {
          return {
            status: 'COMPLETED',
            modified: false,
            original_head_sha: request.candidate.head_sha,
            producer: request.reviewer,
            ...(workerResult.findings ? { findings: workerResult.findings } : {}),
          }
        }

        // 4. If modified, commit changes in worktree
        execFileSync('git', ['add', '.'], { cwd: worktreeDir, stdio: 'pipe', windowsHide: true })
        const commitMsg = workerResult.commit_message || `fix: autonomous repair by ${request.reviewer.principal_id}`
        execFileSync('git', ['commit', '-m', commitMsg], { cwd: worktreeDir, stdio: 'pipe', windowsHide: true })

        // 5. Inspect resulting HEAD
        const newHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: worktreeDir,
          encoding: 'utf8',
          windowsHide: true,
        }).trim()

        // 6. Compute new diff-numstat digest
        const numstatOutput = execFileSync('git', ['diff', '--numstat', request.candidate.base_sha, newHeadSha], {
          cwd: worktreeDir,
          encoding: 'utf8',
          windowsHide: true,
        })
        const newDiffNumstatDigest = createHash('sha256').update(numstatOutput).digest('hex')

        return {
          status: 'COMPLETED',
          modified: true,
          original_head_sha: request.candidate.head_sha,
          new_head_sha: newHeadSha,
          new_diff_numstat_digest: newDiffNumstatDigest,
          producer: request.reviewer,
          commit_message: commitMsg,
          ...(workerResult.findings ? { findings: workerResult.findings } : {}),
        }
      } finally {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], {
            cwd: options.repoRoot,
            stdio: 'pipe',
            windowsHide: true,
          })
        } catch {
          if (existsSync(worktreeDir)) {
            rmSync(worktreeDir, { recursive: true, force: true })
          }
        }
        try {
          execFileSync('git', ['branch', '-D', branchName], {
            cwd: options.repoRoot,
            stdio: 'pipe',
            windowsHide: true,
          })
        } catch {
          // ignore
        }
      }
    },
  }
}

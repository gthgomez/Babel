import { BabelEventBus, runBabelPipeline, type PipelineResult } from '../pipeline.js'
import { diagnoseRun, type HaltDiagnosis } from './haltDiagnosis.js'
import {
  evaluateCompletionVerification,
  type CompletionVerificationGate,
} from './completionVerification.js'
import { verifyWorkspaceProject } from './workspaceManager.js'
import { resolveAgentJobModel, type AgentJob, type AgentJobStatus } from './agentJobs.js'
import { withAgentJobEnv } from './agentJobEnv.js'

export interface AgentJobPipelineRun {
  result: PipelineResult
  resolvedModel: string | undefined
  status: AgentJobStatus
  completionVerification: CompletionVerificationGate | null
  diagnosis: HaltDiagnosis
  error: string | null
}

/**
 * Run the authorized pipeline for a job and derive truthful terminal status,
 * including post-completion workspace verification when the pipeline succeeds.
 */
export async function runAgentJobThroughPipeline(job: AgentJob): Promise<AgentJobPipelineRun> {
  const resolvedModel = resolveAgentJobModel(job)
  const eventBus = new BabelEventBus()

  let result: PipelineResult
  try {
    result = await withAgentJobEnv(job, () =>
      runBabelPipeline(job.task, {
        mode: job.mode,
        ...(job.project_root ? { project: job.project_root } : {}),
        ...(resolvedModel ? { modelOverride: resolvedModel } : {}),
        ...(job.model_tier ? { modelTier: job.model_tier } : {}),
        ...(job.execution_profile ? { executionProfile: job.execution_profile as never } : {}),
        ...(job.model_tier === 'escalation' ? { allowExpensive: true } : {}),
        eventBus,
      }),
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const diagnosis = diagnoseRun({
      pipelineStatus: 'FAILED',
      escalation: job.escalation,
    })
    return {
      result: {
        status: 'FAILED',
        runDir: '',
        manifest: {} as PipelineResult['manifest'],
        plan: null,
      },
      resolvedModel,
      status: 'failed',
      completionVerification: null,
      diagnosis,
      error: message,
    }
  }

  const verification =
    result.status === 'COMPLETE' && job.project_root
      ? verifyWorkspaceProject(job.project_root, {
          ...(job.verify_commands.length > 0 ? { commands: job.verify_commands } : {}),
        })
      : null
  const completionVerification = evaluateCompletionVerification({
    pipelineStatus: result.status,
    executionProfile: job.execution_profile,
    projectRoot: job.project_root,
    verification,
  })
  const diagnosis = diagnoseRun({
    runDir: result.runDir,
    pipelineStatus: result.status,
    verification: completionVerification,
    escalation: job.escalation,
  })
  const status: AgentJobStatus =
    completionVerification.status === 'fail'
      ? 'verification_failed'
      : result.status === 'COMPLETE' || result.status === 'SMALL_FIX_COMPLETE'
        ? 'complete'
        : 'failed'

  return {
    result,
    resolvedModel,
    status,
    completionVerification,
    diagnosis,
    error:
      status === 'failed' || status === 'verification_failed' ? diagnosis.headline : null,
  }
}

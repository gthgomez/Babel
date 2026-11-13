import type { AgentJob } from './agentJobs.js'

/** Apply job-scoped execution profile and workspace roots for a single pipeline run. */
export async function withAgentJobEnv<T>(job: AgentJob, run: () => Promise<T>): Promise<T> {
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE']
  const previousProjectRoot = process.env['BABEL_PROJECT_ROOT']
  const previousAllowedRoots = process.env['BABEL_ALLOWED_ROOTS']

  process.env['BABEL_EXECUTION_PROFILE'] = job.execution_profile
  if (job.project_root) {
    process.env['BABEL_PROJECT_ROOT'] = job.project_root
  }
  if (job.approved_roots.length > 0) {
    process.env['BABEL_ALLOWED_ROOTS'] = job.approved_roots.join(',')
  }

  try {
    return await run()
  } finally {
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile
    if (previousProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT']
    else process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot
    if (previousAllowedRoots === undefined) delete process.env['BABEL_ALLOWED_ROOTS']
    else process.env['BABEL_ALLOWED_ROOTS'] = previousAllowedRoots
  }
}

/** Explicit host gate — live provider/network research v2 is disabled unless set. */
export function isResearchV2LiveApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BABEL_RESEARCH_V2_ALLOW_LIVE_API === '1'
}

export function assertResearchV2LiveApiEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isResearchV2LiveApiEnabled(env)) {
    throw new Error(
      'Live research v2 API is disabled. Set BABEL_RESEARCH_V2_ALLOW_LIVE_API=1 only when engine canonical tests pass. Live runs require OpenRouter only (run test:research-v2-openrouter-route-smoke first).',
    )
  }
}

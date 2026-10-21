/** Presence-only check — never read, log, or return the secret value outside transport. */
export function exaApiKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.EXA_API_KEY?.trim())
}

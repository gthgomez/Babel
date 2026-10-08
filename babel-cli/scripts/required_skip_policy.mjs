// License: Apache-2.0 — see LICENSE
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const text = readFileSync(new URL('./required_skip_policy.json', import.meta.url), 'utf8')
const policy = JSON.parse(text)
if (policy.schemaVersion !== 1 || !Array.isArray(policy.rules)) throw new Error('Invalid required skip policy')
export const skipPolicySha256 = createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')

/** A reason alone is insufficient: bind an explicit source/test identity, OS and suite. */
export function reviewedSkip(record, platform, suite, hosted = process.env.GITHUB_ACTIONS === 'true') {
  if (!record || typeof record.path !== 'string' || typeof record.name !== 'string' || typeof record.reason !== 'string') return null
  for (const rule of policy.rules) {
    if (rule.localOnly && hosted) continue
    if (rule.platforms.includes(platform) && rule.suites.includes(suite) &&
        rule.reasons.includes(record.reason) && rule.files[record.path]?.includes(record.name)) {
      return { rule: rule.id, rationale: rule.rationale }
    }
  }
  return null
}

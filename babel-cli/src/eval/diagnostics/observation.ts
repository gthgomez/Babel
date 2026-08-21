/**
 * General observation-blindness predicates (not fixture planted-string detectors).
 */

export function droppedStderr(observation: string, stderr: string): boolean {
  const tail = stderr.trim()
  if (!tail) return false
  const sample = tail.slice(0, 40)
  return !observation.includes(sample) && !/stderr/i.test(observation)
}

export function observationOmitsEvidence(observation: string, evidence: string): boolean {
  const sample = evidence.trim()
  if (!sample) return false
  return !observation.includes(sample.slice(0, Math.min(24, sample.length)))
}

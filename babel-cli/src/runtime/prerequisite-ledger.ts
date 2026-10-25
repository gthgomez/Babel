/**
 * Keyed prerequisite blockers for readiness (P02).
 * Revisions bind relevant environment/grant/resource facts; unrelated reads do not advance them.
 */

export interface PrerequisiteRecord {
  key: string
  revision: string
  reasonCode: string
  remediation?: string
  recordedAtMs: number
}

export interface PrerequisiteBlockerInput {
  key: string
  revision: string
  reasonCode: string
  remediation?: string
}

export class PrerequisiteLedger {
  private readonly active = new Map<string, PrerequisiteRecord>()

  record(blocker: PrerequisiteBlockerInput): void {
    const key = blocker.key.trim()
    if (!key) throw new Error('prerequisite key is required')
    const revision = blocker.revision.trim()
    if (!revision) throw new Error('prerequisite revision is required')
    this.active.set(key, {
      key,
      revision,
      reasonCode: blocker.reasonCode,
      ...(blocker.remediation ? { remediation: blocker.remediation } : {}),
      recordedAtMs: Date.now(),
    })
  }

  /** True when the same key is still blocked at the exact revision. */
  isUnchanged(key: string, revision: string): boolean {
    const entry = this.active.get(key.trim())
    return entry !== undefined && entry.revision === revision.trim()
  }

  /** Clear a blocker when prerequisite facts advance to a new revision. */
  resolve(key: string, newRevision: string): void {
    const trimmed = key.trim()
    const entry = this.active.get(trimmed)
    if (!entry) return
    if (entry.revision !== newRevision.trim()) {
      this.active.delete(trimmed)
    }
  }

  pending(): readonly PrerequisiteRecord[] {
    return [...this.active.values()].sort((left, right) => left.key.localeCompare(right.key))
  }
}

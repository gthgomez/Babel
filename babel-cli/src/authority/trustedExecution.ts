/**
 * Supervisor-owned trust state for Autonomous SWE Foundations V1.1.
 *
 * Evidence and contracts carry opaque references only. The resolver is a
 * trusted dependency of the completion gate; it is deliberately not part of
 * caller-controlled evidence or provenance. This is an in-process registry,
 * not a cryptographic signature or an OS/process isolation boundary.
 */

import { randomUUID } from 'node:crypto'

import {
  isCapabilityId,
  type CapabilityId,
} from './capabilities.js'
import {
  WorkspaceRevisionSchema,
  type WorkspaceRevision,
} from '../evidence/revisionBoundReceipt.js'

export const TRUSTED_EXECUTION_SCHEMA_VERSION = 1 as const

export type TrustedExecutionRole =
  | 'builder'
  | 'reviewer'
  | 'breaker'
  | 'verifier'
  | 'observer'
  | 'system'

export interface TrustedExecutionIdentityV1 {
  schema_version: typeof TRUSTED_EXECUTION_SCHEMA_VERSION
  identity_ref: string
  endpoint_id: string
  role: TrustedExecutionRole
  execution_domain: string
  capabilities: readonly CapabilityId[]
  task_id: string | null
  contract_hash: string | null
  session_id: string | null
  issued_at: string
  expires_at: string | null
  revoked_at: string | null
}

export interface TrustedAuthorityGrantV1 {
  schema_version: typeof TRUSTED_EXECUTION_SCHEMA_VERSION
  grant_ref: string
  source: 'explicit_user'
  capabilities: readonly CapabilityId[]
  task_id: string | null
  session_id: string | null
  contract_hash: string | null
  parent_grant_ref: string | null
  issued_at: string
  expires_at: string | null
  revoked_at: string | null
}

export interface TrustedExecutionContextV1 {
  schema_version: typeof TRUSTED_EXECUTION_SCHEMA_VERSION
  context_ref: string
  task_id: string
  contract_hash: string
  repository: string
  project_root: string | null
  base_sha: string | null
  candidate_sha: string
  candidate_revision: WorkspaceRevision | null
  session_id: string | null
  execution_identity_ref: string
  authority_grant_ref: string | null
  issued_at: string
  expires_at: string | null
  revoked_at: string | null
}

export interface TrustedExecutionContextRefV1 {
  context_ref: string
}

export interface TrustedExecutionResolver {
  resolveExecutionIdentity(
    identityRef: string,
    now?: Date | number,
  ): TrustedExecutionIdentityV1 | undefined
  resolveAuthorityGrant(
    grantRef: string,
    now?: Date | number,
  ): TrustedAuthorityGrantV1 | undefined
  resolveExecutionContext(
    contextRef: string,
    now?: Date | number,
  ): TrustedExecutionContextV1 | undefined
}

export interface TrustedExecutionSupervisor extends TrustedExecutionResolver {
  readonly resolver: TrustedExecutionResolver
  issueExecutionIdentity(input: {
    endpoint_id: string
    role: TrustedExecutionRole
    execution_domain: string
    capabilities: readonly CapabilityId[]
    task_id?: string | null
    contract_hash?: string | null
    session_id?: string | null
    issued_at?: string
    expires_at?: string | null
  }): TrustedExecutionIdentityV1
  issueAuthorityGrant(input: {
    capabilities: readonly CapabilityId[]
    task_id?: string | null
    session_id?: string | null
    contract_hash?: string | null
    issued_at?: string
    expires_at?: string | null
  }): TrustedAuthorityGrantV1
  delegateAuthorityGrant(input: {
    parent_grant_ref: string
    capabilities: readonly CapabilityId[]
    task_id?: string | null
    session_id?: string | null
    contract_hash?: string | null
    issued_at?: string
    expires_at?: string | null
  }): TrustedAuthorityGrantV1
  issueExecutionContext(input: {
    task_id: string
    contract_hash: string
    repository: string
    project_root?: string | null
    base_sha?: string | null
    candidate_sha: string
    candidate_revision?: WorkspaceRevision | null
    session_id?: string | null
    execution_identity_ref: string
    authority_grant_ref?: string | null
    issued_at?: string
    expires_at?: string | null
  }): TrustedExecutionContextV1
  revokeExecutionIdentity(identityRef: string, at?: string): void
  revokeAuthorityGrant(grantRef: string, at?: string): void
  revokeExecutionContext(contextRef: string, at?: string): void
}

/**
 * Babel-owned authority host surface. It intentionally exposes no resolver;
 * completion obtains the resolver from the module-owned host registry.
 */
export type TrustedExecutionHost = Pick<
  TrustedExecutionSupervisor,
  | 'issueExecutionIdentity'
  | 'issueAuthorityGrant'
  | 'delegateAuthorityGrant'
  | 'issueExecutionContext'
  | 'revokeExecutionIdentity'
  | 'revokeAuthorityGrant'
  | 'revokeExecutionContext'
>

function nowValue(now: Date | number = Date.now()): number {
  return typeof now === 'number' ? now : now.getTime()
}

function isActive(
  value: { expires_at: string | null; revoked_at: string | null },
  now: Date | number,
): boolean {
  if (value.revoked_at !== null) return false
  return value.expires_at === null || Date.parse(value.expires_at) > nowValue(now)
}

function requireText(value: string | null | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`Trusted execution ${field} is required.`)
  return value
}

function normalizeCapabilities(
  capabilities: readonly CapabilityId[],
): readonly CapabilityId[] {
  const unique = [...new Set(capabilities)]
  if (unique.some((capability) => !isCapabilityId(capability) || capability === 'unknown'))
    throw new Error('Trusted execution identity contains an unknown capability.')
  return Object.freeze(unique)
}

function freezeIdentity(
  identity: TrustedExecutionIdentityV1,
): TrustedExecutionIdentityV1 {
  return Object.freeze({
    ...identity,
    capabilities: Object.freeze([...identity.capabilities]),
  })
}

function freezeGrant(grant: TrustedAuthorityGrantV1): TrustedAuthorityGrantV1 {
  return Object.freeze({
    ...grant,
    capabilities: Object.freeze([...grant.capabilities]),
  })
}

function freezeContext(context: TrustedExecutionContextV1): TrustedExecutionContextV1 {
  return Object.freeze({
    ...context,
    candidate_revision: context.candidate_revision
      ? Object.freeze({
          ...context.candidate_revision,
          fileHashes: Object.freeze({ ...context.candidate_revision.fileHashes }),
        })
      : null,
  })
}

function assertBinding(
  label: string,
  actual: string | null | undefined,
  expected: string | null | undefined,
): void {
  if ((actual ?? null) !== (expected ?? null))
    throw new Error(`Trusted execution ${label} binding mismatch.`)
}

/** Create the supervisor boundary that owns identity, grant, and context state. */
export function createTrustedExecutionSupervisor(): TrustedExecutionSupervisor {
  const identities = new Map<string, TrustedExecutionIdentityV1>()
  const grants = new Map<string, TrustedAuthorityGrantV1>()
  const contexts = new Map<string, TrustedExecutionContextV1>()

  const resolveExecutionIdentity = (
    identityRef: string,
    now: Date | number = Date.now(),
  ): TrustedExecutionIdentityV1 | undefined => {
    const identity = identities.get(identityRef)
    return identity && isActive(identity, now) ? identity : undefined
  }
  const resolveAuthorityGrant = (
    grantRef: string,
    now: Date | number = Date.now(),
  ): TrustedAuthorityGrantV1 | undefined => {
    const visited = new Set<string>()
    let currentRef: string | null = grantRef
    let child: TrustedAuthorityGrantV1 | undefined
    while (currentRef !== null) {
      if (visited.has(currentRef)) return undefined
      visited.add(currentRef)
      const current = grants.get(currentRef)
      if (!current || !isActive(current, now)) return undefined
      if (child) {
        if (
          child.capabilities.some(
            (capability) => !current.capabilities.includes(capability),
          ) ||
          child.task_id !== current.task_id ||
          child.session_id !== current.session_id ||
          child.contract_hash !== current.contract_hash ||
          (current.expires_at !== null &&
            (child.expires_at === null ||
              Date.parse(child.expires_at) > Date.parse(current.expires_at)))
        ) {
          return undefined
        }
      }
      child = current
      currentRef = current.parent_grant_ref
    }
    return grants.get(grantRef)
  }
  const resolveExecutionContext = (
    contextRef: string,
    now: Date | number = Date.now(),
  ): TrustedExecutionContextV1 | undefined => {
    const context = contexts.get(contextRef)
    return context && isActive(context, now) ? context : undefined
  }
  const resolver: TrustedExecutionResolver = Object.freeze({
    resolveExecutionIdentity,
    resolveAuthorityGrant,
    resolveExecutionContext,
  })

  const supervisor: TrustedExecutionSupervisor = {
    resolver,
    resolveExecutionIdentity,
    resolveAuthorityGrant,
    resolveExecutionContext,
    issueExecutionIdentity(input) {
      const endpointId = requireText(input.endpoint_id, 'endpoint_id')
      const domain = requireText(input.execution_domain, 'execution_domain')
      const capabilities = normalizeCapabilities(input.capabilities)
      if (
        input.role === 'verifier' &&
        !capabilities.includes('certify_evidence')
      ) {
        throw new Error('A verifier identity requires the certify_evidence capability.')
      }
      if (input.role === 'verifier') {
        requireText(input.task_id, 'task_id')
        requireText(input.contract_hash, 'contract_hash')
        if (domain !== 'isolated-verifier')
          throw new Error('Verifier identities require the isolated-verifier domain.')
      }
      const issuedAt = input.issued_at ?? new Date().toISOString()
      const identity = freezeIdentity({
        schema_version: TRUSTED_EXECUTION_SCHEMA_VERSION,
        identity_ref: `identity:${randomUUID()}`,
        endpoint_id: endpointId,
        role: input.role,
        execution_domain: domain,
        capabilities,
        task_id: input.task_id ?? null,
        contract_hash: input.contract_hash ?? null,
        session_id: input.session_id ?? null,
        issued_at: issuedAt,
        expires_at: input.expires_at ?? null,
        revoked_at: null,
      })
      identities.set(identity.identity_ref, identity)
      return identity
    },
    issueAuthorityGrant(input) {
      const capabilities = normalizeCapabilities(input.capabilities)
      const grant = freezeGrant({
        schema_version: TRUSTED_EXECUTION_SCHEMA_VERSION,
        grant_ref: `grant:${randomUUID()}`,
        source: 'explicit_user',
        capabilities,
        task_id: input.task_id ?? null,
        session_id: input.session_id ?? null,
        contract_hash: input.contract_hash ?? null,
        parent_grant_ref: null,
        issued_at: input.issued_at ?? new Date().toISOString(),
        expires_at: input.expires_at ?? null,
        revoked_at: null,
      })
      grants.set(grant.grant_ref, grant)
      return grant
    },
    delegateAuthorityGrant(input) {
      const parent = resolveAuthorityGrant(input.parent_grant_ref)
      if (!parent) throw new Error('Cannot delegate an unknown or inactive authority grant.')
      const capabilities = normalizeCapabilities(input.capabilities)
      if (capabilities.some((capability) => !parent.capabilities.includes(capability)))
        throw new Error('Authority delegation cannot widen capabilities.')
      const taskId = input.task_id ?? parent.task_id
      const sessionId = input.session_id ?? parent.session_id
      const contractHash = input.contract_hash ?? parent.contract_hash
      assertBinding('delegated task', taskId, parent.task_id)
      assertBinding('delegated session', sessionId, parent.session_id)
      assertBinding('delegated contract', contractHash, parent.contract_hash)
      const grant = freezeGrant({
        schema_version: TRUSTED_EXECUTION_SCHEMA_VERSION,
        grant_ref: `grant:${randomUUID()}`,
        source: 'explicit_user',
        capabilities,
        task_id: taskId ?? null,
        session_id: sessionId ?? null,
        contract_hash: contractHash ?? null,
        parent_grant_ref: parent.grant_ref,
        issued_at: input.issued_at ?? new Date().toISOString(),
        expires_at: input.expires_at ?? parent.expires_at,
        revoked_at: null,
      })
      if (
        parent.expires_at !== null &&
        (grant.expires_at === null ||
          Date.parse(grant.expires_at) > Date.parse(parent.expires_at))
      ) {
        throw new Error('Delegated authority cannot outlive its parent grant.')
      }
      grants.set(grant.grant_ref, grant)
      return grant
    },
    issueExecutionContext(input) {
      const taskId = requireText(input.task_id, 'task_id')
      const contractHash = requireText(input.contract_hash, 'contract_hash')
      const repository = requireText(input.repository, 'repository')
      const candidateSha = requireText(input.candidate_sha, 'candidate_sha')
      const candidateRevision = input.candidate_revision
        ? WorkspaceRevisionSchema.parse(input.candidate_revision)
        : null
      if (
        candidateRevision &&
        ((candidateRevision.gitCommitHash !== null &&
          candidateRevision.gitCommitHash !== candidateSha) ||
          (candidateRevision.gitCommitHash === null &&
            candidateRevision.compositeTreeHash !== candidateSha))
      ) {
        throw new Error('Trusted execution candidate revision does not match candidate_sha.')
      }
      const identity = resolveExecutionIdentity(input.execution_identity_ref)
      if (!identity) throw new Error('Cannot bind context to an unknown or inactive identity.')
      assertBinding('identity task', identity.task_id, taskId)
      assertBinding('identity contract', identity.contract_hash, contractHash)
      assertBinding('identity session', identity.session_id, input.session_id)
      if (input.authority_grant_ref !== undefined && input.authority_grant_ref !== null) {
        const grant = resolveAuthorityGrant(input.authority_grant_ref)
        if (!grant) throw new Error('Cannot bind context to an unknown or inactive grant.')
        assertBinding('grant task', grant.task_id, taskId)
        assertBinding('grant session', grant.session_id, input.session_id)
        assertBinding('grant contract', grant.contract_hash, contractHash)
      }
      const context = freezeContext({
        schema_version: TRUSTED_EXECUTION_SCHEMA_VERSION,
        context_ref: `context:${randomUUID()}`,
        task_id: taskId,
        contract_hash: contractHash,
        repository,
        project_root: input.project_root ?? null,
        base_sha: input.base_sha ?? null,
        candidate_sha: candidateSha,
        candidate_revision: candidateRevision,
        session_id: input.session_id ?? null,
        execution_identity_ref: input.execution_identity_ref,
        authority_grant_ref: input.authority_grant_ref ?? null,
        issued_at: input.issued_at ?? new Date().toISOString(),
        expires_at: input.expires_at ?? null,
        revoked_at: null,
      })
      contexts.set(context.context_ref, context)
      return context
    },
    revokeExecutionIdentity(identityRef, at = new Date().toISOString()) {
      const identity = identities.get(identityRef)
      if (identity) identities.set(identityRef, freezeIdentity({ ...identity, revoked_at: at }))
    },
    revokeAuthorityGrant(grantRef, at = new Date().toISOString()) {
      const grant = grants.get(grantRef)
      if (grant) grants.set(grantRef, freezeGrant({ ...grant, revoked_at: at }))
    },
    revokeExecutionContext(contextRef, at = new Date().toISOString()) {
      const context = contexts.get(contextRef)
      if (context) contexts.set(contextRef, freezeContext({ ...context, revoked_at: at }))
    },
  }
  return Object.freeze(supervisor)
}

export function trustedIdentityHasCapability(
  identity: TrustedExecutionIdentityV1,
  capability: CapabilityId,
): boolean {
  return identity.capabilities.includes(capability)
}

const authoritativeSupervisor = createTrustedExecutionSupervisor()

/** Babel's trusted controller boundary for V1.1 authority issuance. */
export const autonomousSWETrustHost: TrustedExecutionHost = Object.freeze({
  issueExecutionIdentity: authoritativeSupervisor.issueExecutionIdentity,
  issueAuthorityGrant: authoritativeSupervisor.issueAuthorityGrant,
  delegateAuthorityGrant: authoritativeSupervisor.delegateAuthorityGrant,
  issueExecutionContext: authoritativeSupervisor.issueExecutionContext,
  revokeExecutionIdentity: authoritativeSupervisor.revokeExecutionIdentity,
  revokeAuthorityGrant: authoritativeSupervisor.revokeAuthorityGrant,
  revokeExecutionContext: authoritativeSupervisor.revokeExecutionContext,
})

/** Internal read-only dependency used by authoritative completion paths. */
export function getAuthoritativeTrustedExecutionResolver(): TrustedExecutionResolver {
  return authoritativeSupervisor.resolver
}

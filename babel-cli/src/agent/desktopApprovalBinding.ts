import type { ApprovalRequest } from './approvalRequests.js';

/** Version 2 is deliberately fail-closed with legacy unscoped clients. */
export interface DesktopApprovalBinding {
  schemaVersion: 2
  request_id: string
  thread_id: string
  turn_id: string
  operation_digest: string
  run_id: string
  expires_at: string
}

export const DESKTOP_APPROVAL_TTL_MS = 5 * 60 * 1000
const identity = (value: unknown): value is string => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value)

/** Reuse the controller's request/operation identity; never invent task authority. */
export function makeDesktopApprovalBinding(
  request: Pick<ApprovalRequest, 'request_id' | 'thread_id' | 'turn_id' | 'operation_digest'>,
  runId: string | undefined,
  now = Date.now(),
): DesktopApprovalBinding | null {
  if (!identity(request.request_id) || !identity(request.thread_id) || !identity(request.turn_id) ||
    typeof request.operation_digest !== 'string' || !/^[a-f0-9]{64}$/.test(request.operation_digest) ||
    typeof runId !== 'string' || !/^[\w-]{1,100}$/.test(runId) || !Number.isFinite(now)) return null
  return { schemaVersion: 2, request_id: request.request_id, thread_id: request.thread_id,
    turn_id: request.turn_id, operation_digest: request.operation_digest, run_id: runId,
    expires_at: new Date(now + DESKTOP_APPROVAL_TTL_MS).toISOString() }
}

/** Stale/wrong-operation replies cannot settle the current request. */
export function matchesDesktopApprovalReply(value: unknown, expected: DesktopApprovalBinding, now = Date.now()): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const reply = value as Record<string, unknown>
  if (reply.decision !== 'allow_once' && reply.decision !== 'deny') return false
  if (!reply.approval || typeof reply.approval !== 'object' || Array.isArray(reply.approval)) return false
  const actual = reply.approval as Record<string, unknown>
  return Number.isFinite(now) && now < Date.parse(expected.expires_at) &&
    (Object.keys(expected) as Array<keyof DesktopApprovalBinding>).every(key => actual[key] === expected[key])
}

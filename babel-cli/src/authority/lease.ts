/**
 * lease.ts — AutonomyLease (V2 authority).
 *
 * The lease is the session/task authority envelope. It is issued OUTSIDE the
 * agent's own actions (env injection / user-owned file) and parsed fail-closed:
 * an unknown capability name, an invalid field, or an unparseable lease
 * invalidates decisions (DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT / lease parse error
 * → deny). The lease is data; the PDP is the decision function.
 *
 * Loading: BABEL_AUTONOMY_LEASE_FILE (path to JSON) or BABEL_AUTONOMY_LEASE
 * (inline JSON). Absent → no lease → legacy `decideAction` behavior unchanged.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ALL_CAPABILITIES, isCapabilityId } from './capabilities.js';

export const LEASE_VERSION = 2;

const capabilityEnum = z.enum(ALL_CAPABILITIES as unknown as [string, ...string[]]);

const LeaseSchema = z
  .object({
    version: z.literal(LEASE_VERSION),
    leaseId: z.string().min(1),
    issuedAt: z.string().optional(),
    expiresAt: z.string().optional(),
    scope: z.object({
      repository: z.string().min(1),
      remote: z.string().min(1).default('origin'),
      worktree: z.enum(['current', 'agent_created', 'isolated']).default('current'),
      objective: z.string().default('current_user_task'),
    }),
    allowedCapabilities: z.array(capabilityEnum).default([]),
    branchPrefixes: z.array(z.string()).default(['feat/', 'fix/', 'refactor/', 'docs/', 'test/']),
    constraints: z
      .object({
        protectedBranches: z.array(z.string()).default(['main']),
        forcePush: z.boolean().default(false),
        remoteRefDelete: z.boolean().default(false),
        releasePublish: z.boolean().default(false),
        productionDeploy: z.boolean().default(false),
        repositoryAdmin: z.boolean().default(false),
        secretsAccess: z.boolean().default(false),
        billing: z.boolean().default(false),
        destructiveDb: z.boolean().default(false),
        scopeExpansion: z.boolean().default(false),
      })
      .default({
        protectedBranches: ['main'],
        forcePush: false,
        remoteRefDelete: false,
        releasePublish: false,
        productionDeploy: false,
        repositoryAdmin: false,
        secretsAccess: false,
        billing: false,
        destructiveDb: false,
        scopeExpansion: false,
      }),
    budgets: z
      .object({
        ciProductRepairRounds: z.number().int().min(0).default(3),
        ciTransientReruns: z.number().int().min(0).default(1),
        prRecreateRounds: z.number().int().min(0).default(1),
        parallelAgents: z.number().int().min(0).default(8),
      })
      .default({
        ciProductRepairRounds: 3,
        ciTransientReruns: 1,
        prRecreateRounds: 1,
        parallelAgents: 8,
      }),
    gates: z.array(capabilityEnum).default([
      'merge',
      'pr_mark_ready',
      'release',
      'production_deploy',
      'repo_admin',
      'security_policy_change',
      'credential_access',
      'destructive_data_delete',
      'shared_history_rewrite',
      'force_push',
      'scope_expansion',
    ]),
    forbidden: z.array(capabilityEnum).default(['expose_credentials']),
  })
  .strict();

export type AutonomyLease = z.infer<typeof LeaseSchema>;

export type LeaseParseResult =
  | { ok: true; lease: AutonomyLease }
  | { ok: false; error: string };

/** Parse lease JSON. Fail-closed: any schema violation → error (→ deny). */
export function parseLeaseJson(json: string): LeaseParseResult {
  try {
    const parsed = JSON.parse(json) as unknown;
    const result = LeaseSchema.safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      return {
        ok: false,
        error: `Invalid lease: ${first?.path.join('.') ?? '?'}: ${first?.message ?? 'schema violation'}`,
      };
    }
    return { ok: true, lease: result.data };
  } catch (e) {
    return { ok: false, error: `Invalid lease JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Validate a lease against the registry. Fail-closed: unknown capability ids
 * anywhere (allowed/gates/forbidden) → invalid.
 */
export function validateLease(lease: AutonomyLease): LeaseParseResult {
  const sets = [lease.allowedCapabilities, lease.gates, lease.forbidden] as const;
  for (const set of sets) {
    for (const cap of set) {
      if (!isCapabilityId(cap)) {
        return { ok: false, error: `Unknown capability in lease: '${cap}'` };
      }
    }
  }
  if (lease.forbidden.includes('expose_credentials') === false) {
    // explicit forbidden list without expose_credentials is suspicious; the
    // PDP still hard-denies expose_credentials regardless — this is a warning.
    // (fail-closed: keep the lease valid; expose_credentials is ALWAYS denied.)
  }
  return { ok: true, lease };
}

/** Load the active lease from the environment. Absent → null (legacy mode). */
export function loadLeaseFromEnv(env: NodeJS.ProcessEnv = process.env): AutonomyLease | null {
  const filePath = env['BABEL_AUTONOMY_LEASE_FILE'];
  const inline = env['BABEL_AUTONOMY_LEASE'];

  let json: string | null = null;
  if (filePath) {
    try {
      json = readFileSync(filePath, 'utf8');
    } catch (e) {
      throw new Error(
        `BABEL_AUTONOMY_LEASE_FILE unreadable — refusing to run with a broken lease: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  } else if (inline && inline.trim() !== '') {
    json = inline;
  } else {
    return null;
  }

  const parsed = parseLeaseJson(json);
  if (!parsed.ok) {
    throw new Error(`BABEL_AUTONOMY_LEASE invalid — refusing to run with a broken lease: ${parsed.error}`);
  }
  const validated = validateLease(parsed.lease);
  if (!validated.ok) {
    throw new Error(`BABEL_AUTONOMY_LEASE invalid — ${validated.error}`);
  }
  return validated.lease;
}

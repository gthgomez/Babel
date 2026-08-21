/**
 * Causal chat-headless reliability benchmark — Stage 1 contract.
 *
 * Slice 0–1 of the causal measurement plan:
 * - Immutable campaign-manifest.json (frozen denominator)
 * - Atomic per-attempt state files (lifecycle, not written into the manifest)
 * - External reconcile for orphaned attempts after process death
 *
 * Zod is the runtime source of truth. JSON Schema is generated via z.toJSONSchema.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// ─── Slice 0 constants ───────────────────────────────────────────────────────

/** Bump when scorer semantics change (axes, eligibility, oracle hierarchy). */
export const CAUSAL_SCORER_VERSION = 'causal-scorer-v1' as const;

/** Stage 1 primary arms (ablations are Stage 2 only).
 *  `raw_opencode` runs the external OpenCode CLI on the identical prepared
 *  workspace WITHOUT Babel — the baseline arm for paired capability-transfer
 *  measurement. See docs/roadmaps/OX_ALPHA_EXPERIMENTAL_PROGRAM.md. */
export const CAUSAL_STAGE1_ARMS = [
  'babel_enforce',
  'babel_shadow',
  'babel_prompt_control',
  'raw_opencode',
] as const;
export type CausalStage1Arm = (typeof CAUSAL_STAGE1_ARMS)[number];

/** Safety floor flags present on every arm (never disabled for causal runs). */
export const CAUSAL_SAFETY_FLOOR = [
  'workspace_isolation',
  'credential_protection',
  'destructive_action_denial',
  'network_provider_limits',
] as const;

export const ATTEMPT_LIFECYCLE = ['queued', 'running', 'terminal', 'orphaned'] as const;
export type AttemptLifecycle = (typeof ATTEMPT_LIFECYCLE)[number];

export const COST_BASIS = [
  'provider_billed',
  'provider_usage_x_pinned_rate',
  'unknown',
] as const;

/** Default grace after process exit before orphan (ms). */
export const DEFAULT_ORPHAN_GRACE_MS = 15_000;

export const CAMPAIGN_MANIFEST_KIND = 'babel_causal_campaign_manifest' as const;
export const ATTEMPT_STATE_KIND = 'babel_causal_attempt_state' as const;
export const RECONCILE_REPORT_KIND = 'babel_causal_reconcile_report' as const;

// ─── Zod schemas (source of truth) ───────────────────────────────────────────

export const CausalStage1ArmSchema = z.enum(CAUSAL_STAGE1_ARMS);

export const ExpectedAttemptSchema = z.object({
  attempt_id: z.string().min(1),
  pair_id: z.string().min(1),
  task_id: z.string().min(1),
  arm: CausalStage1ArmSchema,
  replicate_id: z.number().int().nonnegative(),
  arm_order: z.number().int().nonnegative(),
  arm_config_hash: z.string().min(1),
});
export type ExpectedAttempt = z.infer<typeof ExpectedAttemptSchema>;

export const CampaignIdentitySchema = z.object({
  babel_commit: z.string().nullable(),
  babel_branch: z.string().nullable(),
  dirty_digest: z.string().nullable(),
  project_root: z.string().min(1),
  canonical_remote: z.string().nullable(),
  dataset_path: z.string().min(1),
  dataset_sha256: z.string().nullable(),
  model: z.string().nullable(),
  mode: z.literal('chat-headless'),
  provider: z.enum(['mock', 'live']),
  scorer_version: z.string().min(1),
  safety_floor: z.array(z.string()),
});
export type CampaignIdentity = z.infer<typeof CampaignIdentitySchema>;

export const CampaignManifestSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal(CAMPAIGN_MANIFEST_KIND),
  campaign_id: z.string().min(1),
  stage: z.literal(1),
  created_at: z.string().min(1),
  identity: CampaignIdentitySchema,
  /** Full Stage 1 triple present; false if reliability-only subset. */
  causal_stage1_complete_design: z.boolean(),
  arms: z.array(CausalStage1ArmSchema).min(1),
  replicates: z.number().int().positive(),
  expected_attempts: z.array(ExpectedAttemptSchema).min(1),
  /** Hash of canonical JSON of expected_attempts + identity (manifest integrity). */
  manifest_digest: z.string().min(1),
});
export type CampaignManifest = z.infer<typeof CampaignManifestSchema>;

export const AttemptStateSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal(ATTEMPT_STATE_KIND),
  attempt_id: z.string().min(1),
  campaign_id: z.string().min(1),
  lifecycle: z.enum(ATTEMPT_LIFECYCLE),
  sequence: z.number().int().nonnegative(),
  updated_at: z.string().min(1),
  pair_id: z.string().min(1),
  task_id: z.string().min(1),
  arm: CausalStage1ArmSchema,
  replicate_id: z.number().int().nonnegative(),
  /** Substage within attempt (infra prep is not a separate capability row). */
  substage: z.enum(['pending', 'infra', 'live', 'done']).optional(),
  terminal_signature: z.string().nullable().optional(),
  cell_evidence_path: z.string().nullable().optional(),
  orphan_reason: z.string().nullable().optional(),
  /** When lifecycle is terminal but payload failed validation. */
  quarantined: z.boolean().optional(),
  quarantine_path: z.string().nullable().optional(),
});
export type AttemptState = z.infer<typeof AttemptStateSchema>;

export const ReconcileReportSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal(RECONCILE_REPORT_KIND),
  campaign_id: z.string().min(1),
  evidence_dir: z.string().min(1),
  reconciled_at: z.string().min(1),
  process_alive: z.boolean(),
  process_tree_alive: z.boolean(),
  grace_remaining_ms: z.number().int().nonnegative(),
  campaign_complete: z.boolean(),
  expected_count: z.number().int().nonnegative(),
  by_lifecycle: z.record(z.string(), z.number().int().nonnegative()),
  orphaned_attempt_ids: z.array(z.string()),
  conservation_ok: z.boolean(),
  conservation_errors: z.array(z.string()),
  notes: z.array(z.string()),
});
export type ReconcileReport = z.infer<typeof ReconcileReportSchema>;

// ─── Hash / atomic I/O helpers ───────────────────────────────────────────────

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Crash-safer write: temp file + rename (Windows-friendly vs partial overwrite).
 */
export function writeJsonAtomic(targetPath: string, data: unknown): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, targetPath);
  } catch {
    // Windows: target may exist — overwrite via write after unlink attempt
    try {
      writeFileSync(targetPath, content, 'utf8');
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

// ─── Arm config hash ─────────────────────────────────────────────────────────

export function computeArmConfigHash(input: {
  arm: CausalStage1Arm;
  prompt_delta_id: string;
  enforcement: 'full' | 'shadow';
  safety_floor: readonly string[];
  scorer_version: string;
}): string {
  return sha256Hex(
    stableStringify({
      arm: input.arm,
      prompt_delta_id: input.prompt_delta_id,
      enforcement: input.enforcement,
      safety_floor: [...input.safety_floor].sort(),
      scorer_version: input.scorer_version,
    }),
  ).slice(0, 16);
}

export function defaultArmConfig(arm: CausalStage1Arm): {
  prompt_delta_id: string;
  enforcement: 'full' | 'shadow';
} {
  switch (arm) {
    case 'babel_enforce':
      return { prompt_delta_id: 'product_full', enforcement: 'full' };
    case 'babel_shadow':
      return { prompt_delta_id: 'product_full', enforcement: 'shadow' };
    case 'babel_prompt_control':
      return { prompt_delta_id: 'product_minus_suppressive_v1', enforcement: 'shadow' };
    case 'raw_opencode':
      // External baseline: no Babel prompt delta, no shadow policy surface.
      // `enforcement` is carried for schema/hash stability only.
      return { prompt_delta_id: 'external_cli_none', enforcement: 'full' };
    default: {
      const _exhaustive: never = arm;
      return _exhaustive;
    }
  }
}

// ─── Attempt IDs ─────────────────────────────────────────────────────────────

export function makePairId(taskId: string, replicateId: number): string {
  return `pair_${sha256Hex(`${taskId}|${replicateId}`).slice(0, 12)}`;
}

export function makeAttemptId(input: {
  campaignId: string;
  taskId: string;
  arm: CausalStage1Arm;
  replicateId: number;
}): string {
  return `att_${sha256Hex(
    `${input.campaignId}|${input.taskId}|${input.arm}|${input.replicateId}`,
  ).slice(0, 16)}`;
}

// ─── Manifest build ──────────────────────────────────────────────────────────

export interface BuildManifestInput {
  campaignId: string;
  createdAt?: string;
  taskIds: string[];
  arms?: CausalStage1Arm[];
  replicates?: number;
  /** Optional fixed arm order per replicate (default: natural arm list order). */
  armOrder?: CausalStage1Arm[];
  identity: Omit<CampaignIdentity, 'mode' | 'scorer_version' | 'safety_floor'> & {
    mode?: 'chat-headless';
    scorer_version?: string;
    safety_floor?: string[];
  };
}

export function buildCampaignManifest(input: BuildManifestInput): CampaignManifest {
  const arms = input.arms?.length ? input.arms : (['babel_enforce'] as CausalStage1Arm[]);
  for (const a of arms) {
    if (!CAUSAL_STAGE1_ARMS.includes(a)) {
      throw new Error(`Invalid Stage 1 arm: ${a}`);
    }
  }
  const replicates = input.replicates ?? 1;
  if (replicates < 1) throw new Error('replicates must be >= 1');
  if (!input.taskIds.length) throw new Error('taskIds required');

  const order = input.armOrder?.length ? input.armOrder : arms;
  const expected: ExpectedAttempt[] = [];

  for (let r = 0; r < replicates; r += 1) {
    for (const taskId of input.taskIds) {
      const pair_id = makePairId(taskId, r);
      let orderIdx = 0;
      for (const arm of order) {
        if (!arms.includes(arm)) continue;
        const cfg = defaultArmConfig(arm);
        const arm_config_hash = computeArmConfigHash({
          arm,
          ...cfg,
          safety_floor: CAUSAL_SAFETY_FLOOR,
          scorer_version: input.identity.scorer_version ?? CAUSAL_SCORER_VERSION,
        });
        expected.push({
          attempt_id: makeAttemptId({
            campaignId: input.campaignId,
            taskId,
            arm,
            replicateId: r,
          }),
          pair_id,
          task_id: taskId,
          arm,
          replicate_id: r,
          arm_order: orderIdx,
          arm_config_hash,
        });
        orderIdx += 1;
      }
    }
  }

  const identity: CampaignIdentity = {
    babel_commit: input.identity.babel_commit,
    babel_branch: input.identity.babel_branch,
    dirty_digest: input.identity.dirty_digest,
    project_root: input.identity.project_root,
    canonical_remote: input.identity.canonical_remote,
    dataset_path: input.identity.dataset_path,
    dataset_sha256: input.identity.dataset_sha256,
    model: input.identity.model,
    mode: 'chat-headless',
    provider: input.identity.provider,
    scorer_version: input.identity.scorer_version ?? CAUSAL_SCORER_VERSION,
    safety_floor: input.identity.safety_floor ?? [...CAUSAL_SAFETY_FLOOR],
  };

  const causal_stage1_complete_design =
    CAUSAL_STAGE1_ARMS.every((a) => arms.includes(a)) && arms.length === CAUSAL_STAGE1_ARMS.length;

  const draft = {
    schema_version: 1 as const,
    kind: CAMPAIGN_MANIFEST_KIND,
    campaign_id: input.campaignId,
    stage: 1 as const,
    created_at: input.createdAt ?? new Date().toISOString(),
    identity,
    causal_stage1_complete_design,
    arms,
    replicates,
    expected_attempts: expected,
  };
  const manifest_digest = sha256Hex(stableStringify(draft));
  const manifest: CampaignManifest = { ...draft, manifest_digest };
  return CampaignManifestSchema.parse(manifest);
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function manifestPath(evidenceDir: string): string {
  return join(evidenceDir, 'campaign-manifest.json');
}

export function attemptsDir(evidenceDir: string): string {
  return join(evidenceDir, 'attempts');
}

export function attemptStatePath(evidenceDir: string, attemptId: string): string {
  return join(attemptsDir(evidenceDir), `${attemptId}.json`);
}

export function quarantineDir(evidenceDir: string): string {
  return join(evidenceDir, 'quarantine');
}

export function reconcileReportPath(evidenceDir: string): string {
  return join(evidenceDir, 'reconcile-report.json');
}

// ─── Manifest I/O (immutable after write) ────────────────────────────────────

export function writeCampaignManifest(evidenceDir: string, manifest: CampaignManifest): string {
  const path = manifestPath(evidenceDir);
  if (existsSync(path)) {
    const existing = CampaignManifestSchema.parse(readJsonFile(path));
    if (existing.manifest_digest !== manifest.manifest_digest) {
      throw new Error(
        `campaign-manifest.json already exists with different digest (immutable). existing=${existing.manifest_digest} new=${manifest.manifest_digest}`,
      );
    }
    return path;
  }
  const parsed = CampaignManifestSchema.parse(manifest);
  writeJsonAtomic(path, parsed);
  return path;
}

export function loadCampaignManifest(evidenceDir: string): CampaignManifest {
  const path = manifestPath(evidenceDir);
  if (!existsSync(path)) {
    throw new Error(`campaign-manifest.json missing: ${path}`);
  }
  return CampaignManifestSchema.parse(readJsonFile(path));
}

// ─── Attempt state I/O ───────────────────────────────────────────────────────

export function writeAttemptState(evidenceDir: string, state: AttemptState): string {
  const parsed = AttemptStateSchema.parse(state);
  const path = attemptStatePath(evidenceDir, parsed.attempt_id);
  writeJsonAtomic(path, parsed);
  return path;
}

export function loadAttemptState(evidenceDir: string, attemptId: string): AttemptState | null {
  const path = attemptStatePath(evidenceDir, attemptId);
  if (!existsSync(path)) return null;
  return AttemptStateSchema.parse(readJsonFile(path));
}

export function listAttemptStates(evidenceDir: string): AttemptState[] {
  const dir = attemptsDir(evidenceDir);
  if (!existsSync(dir)) return [];
  const out: AttemptState[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(AttemptStateSchema.parse(readJsonFile(join(dir, name))));
    } catch {
      // Quarantine path is separate; invalid attempt files are reported by validateConservation
    }
  }
  return out;
}

export function seedQueuedAttempts(
  evidenceDir: string,
  manifest: CampaignManifest,
  now?: Date,
): AttemptState[] {
  const ts = (now ?? new Date()).toISOString();
  const states: AttemptState[] = [];
  for (const exp of manifest.expected_attempts) {
    const existing = loadAttemptState(evidenceDir, exp.attempt_id);
    if (existing) {
      states.push(existing);
      continue;
    }
    const state: AttemptState = {
      schema_version: 1,
      kind: ATTEMPT_STATE_KIND,
      attempt_id: exp.attempt_id,
      campaign_id: manifest.campaign_id,
      lifecycle: 'queued',
      sequence: 0,
      updated_at: ts,
      pair_id: exp.pair_id,
      task_id: exp.task_id,
      arm: exp.arm,
      replicate_id: exp.replicate_id,
      substage: 'pending',
      terminal_signature: null,
      cell_evidence_path: null,
      orphan_reason: null,
    };
    writeAttemptState(evidenceDir, state);
    states.push(state);
  }
  return states;
}

/**
 * Advance attempt lifecycle with monotonic sequence.
 * Refuses illegal transitions (e.g. terminal → running).
 */
export function transitionAttempt(
  evidenceDir: string,
  attemptId: string,
  next: {
    lifecycle: AttemptLifecycle;
    substage?: AttemptState['substage'];
    terminal_signature?: string | null;
    cell_evidence_path?: string | null;
    orphan_reason?: string | null;
    quarantined?: boolean;
    quarantine_path?: string | null;
  },
  now?: Date,
): AttemptState {
  const cur = loadAttemptState(evidenceDir, attemptId);
  if (!cur) {
    throw new Error(`attempt state missing: ${attemptId}`);
  }
  assertLegalTransition(cur.lifecycle, next.lifecycle);
  const state: AttemptState = {
    ...cur,
    lifecycle: next.lifecycle,
    sequence: cur.sequence + 1,
    updated_at: (now ?? new Date()).toISOString(),
    ...(next.substage !== undefined ? { substage: next.substage } : {}),
    ...(next.terminal_signature !== undefined
      ? { terminal_signature: next.terminal_signature }
      : {}),
    ...(next.cell_evidence_path !== undefined
      ? { cell_evidence_path: next.cell_evidence_path }
      : {}),
    ...(next.orphan_reason !== undefined ? { orphan_reason: next.orphan_reason } : {}),
    ...(next.quarantined !== undefined ? { quarantined: next.quarantined } : {}),
    ...(next.quarantine_path !== undefined ? { quarantine_path: next.quarantine_path } : {}),
  };
  writeAttemptState(evidenceDir, state);
  return state;
}

export function assertLegalTransition(from: AttemptLifecycle, to: AttemptLifecycle): void {
  if (from === to) return;
  const allowed: Record<AttemptLifecycle, AttemptLifecycle[]> = {
    queued: ['running', 'orphaned', 'terminal'],
    running: ['terminal', 'orphaned'],
    terminal: [],
    orphaned: [],
  };
  if (!allowed[from].includes(to)) {
    throw new Error(`illegal attempt lifecycle transition ${from} → ${to}`);
  }
}

// ─── Conservation ────────────────────────────────────────────────────────────

export interface ConservationResult {
  ok: boolean;
  errors: string[];
  by_lifecycle: Record<string, number>;
  expected_count: number;
  observed_count: number;
}

/**
 * Every expected attempt is exactly one of queued|running|terminal|orphaned.
 * No extras, no missing, no duplicate attempt_ids.
 */
export function validateConservation(
  manifest: CampaignManifest,
  states: AttemptState[],
): ConservationResult {
  const errors: string[] = [];
  const expectedIds = new Set(manifest.expected_attempts.map((a) => a.attempt_id));
  const by_lifecycle: Record<string, number> = {
    queued: 0,
    running: 0,
    terminal: 0,
    orphaned: 0,
  };

  const seen = new Set<string>();
  for (const s of states) {
    if (seen.has(s.attempt_id)) {
      errors.push(`duplicate attempt_id: ${s.attempt_id}`);
    }
    seen.add(s.attempt_id);
    if (!expectedIds.has(s.attempt_id)) {
      errors.push(`unexpected attempt_id not in manifest: ${s.attempt_id}`);
    }
    if (s.campaign_id !== manifest.campaign_id) {
      errors.push(`campaign_id mismatch on ${s.attempt_id}`);
    }
    by_lifecycle[s.lifecycle] = (by_lifecycle[s.lifecycle] ?? 0) + 1;
  }

  for (const id of expectedIds) {
    if (!seen.has(id)) {
      errors.push(`missing attempt state for expected: ${id}`);
    }
  }

  // Sequence monotonicity per attempt is inherent in single-file state; check non-negative
  for (const s of states) {
    if (s.sequence < 0) errors.push(`negative sequence on ${s.attempt_id}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    by_lifecycle,
    expected_count: expectedIds.size,
    observed_count: seen.size,
  };
}

export function campaignCompleteFromStates(
  manifest: CampaignManifest,
  states: AttemptState[],
): boolean {
  const cons = validateConservation(manifest, states);
  if (!cons.ok) return false;
  return states.every((s) => s.lifecycle === 'terminal' || s.lifecycle === 'orphaned');
}

// ─── Process / reconcile (external owner) ────────────────────────────────────

export interface ProcessLaunchRecord {
  schema_version?: number;
  pid?: number;
  started_at?: string;
  launch_method?: string;
  creation_identity?: string;
  evidence_dir?: string;
  campaign_id?: string;
}

export function loadProcessRecord(evidenceDir: string): ProcessLaunchRecord | null {
  const path = join(evidenceDir, 'process.json');
  if (!existsSync(path)) return null;
  try {
    return readJsonFile(path) as ProcessLaunchRecord;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort process-tree liveness on Windows (WMI) and POSIX (pgrep/ps).
 * PID-only absence is not sufficient alone for orphan — pair with creation identity + grace.
 */
export function isProcessTreeAlive(rootPid: number): boolean {
  if (!isPidAlive(rootPid)) {
    // On Windows the recorded pid may be cmd.exe that already exited while children live —
    // still check for descendants via WMI when available.
  }
  if (process.platform === 'win32') {
    try {
      const ps = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$root=${rootPid}; function Kids($p){ Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $_; Kids $_.ProcessId } }; $all=@(); if (Get-Process -Id $root -ErrorAction SilentlyContinue) { $all += Get-Process -Id $root }; $all += @(Kids $root); if ($all.Count -gt 0) { 'alive' } else { 'dead' }`,
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
      const out = `${ps.stdout ?? ''}${ps.stderr ?? ''}`.toLowerCase();
      if (out.includes('alive')) return true;
      if (out.includes('dead')) return false;
    } catch {
      /* fall through */
    }
    return isPidAlive(rootPid);
  }
  // POSIX: root alive or any child
  if (isPidAlive(rootPid)) return true;
  try {
    const ps = spawnSync('pgrep', ['-P', String(rootPid)], { encoding: 'utf8', timeout: 5_000 });
    return (ps.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

export function processCreationIdentity(record: ProcessLaunchRecord): string {
  if (record.creation_identity) return record.creation_identity;
  return sha256Hex(
    stableStringify({
      pid: record.pid ?? null,
      started_at: record.started_at ?? null,
      launch_method: record.launch_method ?? null,
      evidence_dir: record.evidence_dir ?? null,
    }),
  ).slice(0, 16);
}

export interface ReconcileOptions {
  evidenceDir: string;
  graceMs?: number;
  /** Inject clock for tests */
  nowMs?: number;
  /** Inject process liveness for tests */
  processTreeAlive?: boolean | null;
  /** Inject process record for tests */
  processRecord?: ProcessLaunchRecord | null;
}

/**
 * Idempotent external reconcile:
 * - Load immutable manifest
 * - Confirm process-tree death + creation identity + grace period
 * - Mark running/queued attempts orphaned when worker is dead
 * - Never trusts writer "complete" booleans alone
 */
export function reconcileCampaignEvidence(options: ReconcileOptions): ReconcileReport {
  const evidenceDir = options.evidenceDir;
  const notes: string[] = [];
  const graceMs = options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const nowMs = options.nowMs ?? Date.now();

  const manifest = loadCampaignManifest(evidenceDir);
  let states = listAttemptStates(evidenceDir);

  // Seed any missing as queued so conservation can see them
  if (states.length < manifest.expected_attempts.length) {
    seedQueuedAttempts(evidenceDir, manifest, new Date(nowMs));
    states = listAttemptStates(evidenceDir);
  }

  const proc =
    options.processRecord !== undefined
      ? options.processRecord
      : loadProcessRecord(evidenceDir);

  const pid = proc?.pid ?? null;
  const process_alive = pid != null ? isPidAlive(pid) : false;
  let process_tree_alive: boolean;
  if (options.processTreeAlive != null) {
    process_tree_alive = options.processTreeAlive;
  } else if (pid != null) {
    process_tree_alive = isProcessTreeAlive(pid);
  } else {
    process_tree_alive = false;
    notes.push('no_process_record');
  }

  let grace_remaining_ms = 0;
  let mayOrphan = false;

  if (process_tree_alive) {
    notes.push('process_tree_alive_skip_orphan');
    mayOrphan = false;
  } else if (!proc || pid == null) {
    // No process identity: only orphan if campaign-report missing and attempts still open
    // after grace from manifest created_at
    const created = Date.parse(manifest.created_at);
    const elapsed = Number.isFinite(created) ? nowMs - created : graceMs;
    grace_remaining_ms = Math.max(0, Math.floor(graceMs - elapsed));
    mayOrphan = grace_remaining_ms === 0;
    if (!mayOrphan) notes.push('grace_wait_no_process_record');
    else notes.push('orphan_allowed_no_process_record_after_grace');
  } else {
    // Use recorded timestamps only (started_at / heartbeat). Do not use process.json
    // mtime: it is wall-clock and breaks injected clocks / clock skew vs started_at.
    const started = proc.started_at ? Date.parse(proc.started_at) : NaN;
    let exitAnchor = Number.isFinite(started) ? started : NaN;
    try {
      const hbPath = join(evidenceDir, 'heartbeat.json');
      if (existsSync(hbPath)) {
        const hb = readJsonFile(hbPath) as { last_progress_at?: string };
        if (hb.last_progress_at) {
          const t = Date.parse(hb.last_progress_at);
          if (Number.isFinite(t)) {
            exitAnchor = Number.isFinite(exitAnchor) ? Math.max(exitAnchor, t) : t;
          }
        }
      }
    } catch {
      /* ignore */
    }
    if (!Number.isFinite(exitAnchor)) {
      // Last resort: process.json mtime when no recorded timestamps exist
      const procPath = join(evidenceDir, 'process.json');
      if (existsSync(procPath)) {
        try {
          exitAnchor = statSync(procPath).mtimeMs;
        } catch {
          exitAnchor = nowMs;
        }
      } else {
        exitAnchor = nowMs;
      }
    }
    // Grace from last known activity until now (injected or wall clock).
    const idleMs = nowMs - exitAnchor;
    grace_remaining_ms = Math.max(0, Math.floor(graceMs - idleMs));
    mayOrphan = grace_remaining_ms === 0;
    const identity = processCreationIdentity(proc);
    notes.push(`creation_identity=${identity}`);
    if (!mayOrphan) notes.push('grace_wait_after_process_death');
    else notes.push('orphan_allowed_after_grace');
  }

  const orphaned_attempt_ids: string[] = [];
  if (mayOrphan && !process_tree_alive) {
    for (const s of states) {
      if (s.lifecycle === 'queued' || s.lifecycle === 'running') {
        transitionAttempt(
          evidenceDir,
          s.attempt_id,
          {
            lifecycle: 'orphaned',
            orphan_reason: 'process_dead_without_terminal_after_grace',
            terminal_signature: 'agent:orphaned',
          },
          new Date(nowMs),
        );
        orphaned_attempt_ids.push(s.attempt_id);
      }
    }
    if (orphaned_attempt_ids.length) {
      states = listAttemptStates(evidenceDir);
    }
  }

  const conservation = validateConservation(manifest, states);
  const complete = campaignCompleteFromStates(manifest, states);

  const report: ReconcileReport = {
    schema_version: 1,
    kind: RECONCILE_REPORT_KIND,
    campaign_id: manifest.campaign_id,
    evidence_dir: evidenceDir,
    reconciled_at: new Date(nowMs).toISOString(),
    process_alive,
    process_tree_alive,
    grace_remaining_ms,
    campaign_complete: complete && conservation.ok,
    expected_count: conservation.expected_count,
    by_lifecycle: conservation.by_lifecycle,
    orphaned_attempt_ids,
    conservation_ok: conservation.ok,
    conservation_errors: conservation.errors,
    notes,
  };

  const parsed = ReconcileReportSchema.parse(report);
  writeJsonAtomic(reconcileReportPath(evidenceDir), parsed);
  return parsed;
}

// ─── Git / dataset identity helpers ──────────────────────────────────────────

export function captureGitIdentity(cwd: string): {
  babel_commit: string | null;
  babel_branch: string | null;
  dirty_digest: string | null;
  canonical_remote: string | null;
} {
  const run = (args: string[]): string | null => {
    try {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
      if (r.status !== 0) return null;
      return (r.stdout ?? '').trim() || null;
    } catch {
      return null;
    }
  };
  const babel_commit = run(['rev-parse', 'HEAD']);
  const babel_branch = run(['branch', '--show-current']);
  const status = run(['status', '--porcelain']);
  const dirty_digest = status != null ? sha256Hex(status).slice(0, 16) : null;
  const remote = run(['remote', 'get-url', 'origin']);
  return {
    babel_commit,
    babel_branch,
    dirty_digest: status && status.length > 0 ? dirty_digest : dirty_digest === null ? null : 'clean',
    canonical_remote: remote,
  };
}

export function hashFileSha256(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return null;
  }
}

// ─── JSON Schema export ──────────────────────────────────────────────────────

export function causalManifestJsonSchema(): unknown {
  return z.toJSONSchema(CampaignManifestSchema);
}

export function causalAttemptStateJsonSchema(): unknown {
  return z.toJSONSchema(AttemptStateSchema);
}

export function writeGeneratedCausalSchemas(schemaDir: string): {
  manifest: string;
  attempt: string;
  reconcile: string;
} {
  mkdirSync(schemaDir, { recursive: true });
  const manifest = join(schemaDir, 'causal-campaign-manifest.schema.json');
  const attempt = join(schemaDir, 'causal-attempt-state.schema.json');
  const reconcile = join(schemaDir, 'causal-reconcile-report.schema.json');
  writeJsonAtomic(manifest, z.toJSONSchema(CampaignManifestSchema));
  writeJsonAtomic(attempt, z.toJSONSchema(AttemptStateSchema));
  writeJsonAtomic(reconcile, z.toJSONSchema(ReconcileReportSchema));
  return { manifest, attempt, reconcile };
}

/**
 * Map a legacy live cell completion onto attempt terminal state.
 * Infra cells are substages, not separate expected attempts.
 */
export function findAttemptForTaskArm(
  manifest: CampaignManifest,
  taskId: string,
  arm: CausalStage1Arm = 'babel_enforce',
  replicateId = 0,
): ExpectedAttempt | undefined {
  return manifest.expected_attempts.find(
    (a) => a.task_id === taskId && a.arm === arm && a.replicate_id === replicateId,
  );
}

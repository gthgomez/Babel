/**
 * observationStore.ts — A11a shadow observation store.
 *
 * This module implements the A11a separation between three concepts:
 *
 *   1. immutable payload  — content-addressed approved bytes (full SHA-256,
 *      byte length, representation/encoding, channel, media type, capture and
 *      redaction policy versions). Content hash dedupes identical approved
 *      bytes; it is NOT invocation identity.
 *   2. observation ref     — stable invocation/operation identity plus parent
 *      task/turn/run, payload refs for stdout/stderr/structured sections,
 *      execution status, snapshot/coverage ref, capture completeness and
 *      permitted principals. Two identical outputs from different executions
 *      remain distinct because the observation id is derived from invocation
 *      identity, never from content.
 *   3. projection          — pure model-visible selection for a context
 *      epoch/logical request and policy version. It points at immutable refs
 *      and changes nothing.
 *
 * Scope: shadow/pure helper only. It does not touch the production prompt
 * projection, `prepareProviderRequest`, chat tool definitions, or any
 * controller DB/PDP/event log. Production admission (P06/P07) is out of scope.
 *
 * Durability statement (explicit, not a blanket power-loss guarantee):
 *   - Objects and refs are created with exclusive/atomic creation and the
 *     object key is content-addressed; an existing object is size/hash
 *     verified before reuse.
 *   - When the configured durability mode is `fsync_file_and_dir`, each newly
 *     written file is fsynced and its containing directory is fsynced.
 *   - Atomic rename alone is never advertised as a power-loss guarantee.
 *   - If file+directory syncing is unsupported or fails, capture returns an
 *     explicit `evidence_degraded` result rather than claiming durability.
 *   - Budget accounting is process-local in the default port. Durable
 *     per-run/total limits across process restarts remain a P06/P07
 *     integration requirement and are called out as a known gap here.
 *
 * Fault semantics: a failed archive never authorizes effect replay. Completed
 * work stays completed even when evidence persistence fails; the caller keeps
 * the previous approved observation or receives an explicit degraded/blocked
 * result. Never replace a visible observation with an inaccessible handle.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256Canonical } from '../acceptance/canonical.js';
import { isCredentialDeniedOutput } from '../agent/codingLoop/observationCompiler.js';

export const OBSERVATION_STORE_SCHEMA_VERSION = 1 as const;

/**
 * Conservative project defaults, NOT SoL-Pi numeric thresholds. These are
 * deliberately small enough to exercise bounded behaviour in tests and must be
 * re-approved by the P11 owner before any production use.
 */
export const OBSERVATION_CAPTURE_POLICY_DEFAULTS_V1 = {
  policy_version: 'p11-capture-policy-v1',
  redaction_policy_version: 'p11-redaction-policy-v1',
  max_object_bytes: 4 * 1024 * 1024,
  max_run_bytes: 64 * 1024 * 1024,
  max_total_bytes: 1024 * 1024 * 1024,
  page_bytes_default: 64 * 1024,
  page_bytes_max: 1024 * 1024,
  durability: 'fsync_file_and_dir',
} as const;

export const OBSERVATION_DURABILITY_STATEMENT =
  'exclusive content-addressed object creation; optional fsync file+dir; ' +
  'atomic rename alone is not a power-loss guarantee; unsupported sync is ' +
  'reported as evidence_degraded, never claimed as durable';

export type ObservationDurabilityMode = 'fsync_file_and_dir' | 'none';

export interface CapturePolicyV1 {
  policy_version: string;
  redaction_policy_version: string;
  max_object_bytes: number;
  max_run_bytes: number;
  max_total_bytes: number;
  page_bytes_default: number;
  page_bytes_max: number;
  durability: ObservationDurabilityMode;
}

export type ObservationChannelV1 =
  | 'stdout'
  | 'stderr'
  | 'structured'
  | 'summary'
  | 'checkpoint';

export type ObservationEncodingV1 = 'utf8' | 'base64';
export type ObservationRepresentationV1 = 'text' | 'binary';
export type ObservationCompletenessV1 =
  | 'complete'
  | 'truncated_upstream'
  | 'decoded_upstream'
  | 'unknown';

export type ObservationExecutionStatusV1 =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'denied'
  | 'indeterminate'
  | 'unknown';

/** Immutable, content-addressed payload metadata (bytes live at object_key). */
export interface ObservationPayloadV1 {
  payload_id: string;
  sha256: string;
  byte_length: number;
  representation: ObservationRepresentationV1;
  encoding: ObservationEncodingV1;
  channel: ObservationChannelV1;
  media_type: string;
  capture_policy_version: string;
  redaction_policy_version: string;
  capture_completeness: ObservationCompletenessV1;
  object_key: string;
}

export interface ObservationInvocationV1 {
  operation_id: string;
  task_id: string;
  run_id: string;
  turn_id?: string;
  attempt_id?: string;
}

/** Stable invocation reference; not derived from content. */
export interface ObservationRefV1 {
  schema_version: typeof OBSERVATION_STORE_SCHEMA_VERSION;
  observation_id: string;
  invocation: ObservationInvocationV1;
  payloads: ObservationPayloadV1[];
  execution_status: ObservationExecutionStatusV1;
  snapshot_ref?: string;
  coverage_ref?: string;
  capture_completeness: ObservationCompletenessV1;
  permitted_principals: string[];
  capture_policy_version: string;
  redaction_policy_version: string;
  captured_at: string;
}

// ---------------------------------------------------------------------------
// Storage ports
// ---------------------------------------------------------------------------

/** Filesystem seam; the default implementation uses node:fs. */
export interface ObservationStorageFsV1 {
  mkdirp(path: string): void;
  /** Exclusive create; throws with `code === 'EEXIST'` when the path exists. */
  writeFileExclusive(path: string, bytes: Uint8Array, mode: number): void;
  syncFile(path: string): void;
  syncDir(path: string): void;
  readFile(path: string): Uint8Array;
  exists(path: string): boolean;
  isSymbolicLink(path: string): boolean;
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;
  byteLength(path: string): number;
  listDirectory(path: string): readonly string[];
  unlink(path: string): void;
  realpath(path: string): string;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function createNodeObservationFs(): ObservationStorageFsV1 {
  return {
    mkdirp(path: string): void {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    writeFileExclusive(path: string, bytes: Uint8Array, mode: number): void {
      const fd = openSync(path, 'wx', mode);
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          written += writeSync(fd, bytes, written, bytes.byteLength - written);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    syncFile(path: string): void {
      const fd = openSync(path, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    syncDir(path: string): void {
      const fd = openSync(path, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    readFile(path: string): Uint8Array {
      return readFileSync(path);
    },
    exists(path: string): boolean {
      return existsSync(path);
    },
    isSymbolicLink(path: string): boolean {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      return stat ? stat.isSymbolicLink() : false;
    },
    isDirectory(path: string): boolean {
      const stat = statSync(path, { throwIfNoEntry: false });
      return stat ? stat.isDirectory() : false;
    },
    isFile(path: string): boolean {
      const stat = statSync(path, { throwIfNoEntry: false });
      return stat ? stat.isFile() : false;
    },
    byteLength(path: string): number {
      return statSync(path).size;
    },
    listDirectory(path: string): readonly string[] {
      return readdirSync(path);
    },
    unlink(path: string): void {
      unlinkSync(path);
    },
    realpath(path: string): string {
      return realpathSync(path);
    },
  };
}

export interface ObservationBudgetUsageV1 {
  run_bytes: number;
  total_bytes: number;
}

/**
 * Per-run/total write accounting seam. The default implementation is
 * process-local; see the module durability statement for the restart gap.
 */
export interface ObservationBudgetPortV1 {
  usage(run_id: string): ObservationBudgetUsageV1;
  record(run_id: string, bytes: number): void;
}

export function createInMemoryObservationBudget(
  init: { run_bytes?: number; total_bytes?: number } = {},
): ObservationBudgetPortV1 {
  const perRun = new Map<string, number>();
  let total = init.total_bytes ?? 0;
  const seed = init.run_bytes ?? 0;
  return {
    usage(run_id: string): ObservationBudgetUsageV1 {
      return { run_bytes: perRun.get(run_id) ?? seed, total_bytes: total };
    },
    record(run_id: string, bytes: number): void {
      perRun.set(run_id, (perRun.get(run_id) ?? seed) + bytes);
      total += bytes;
    },
  };
}

export interface ObservationStorageContextV1 {
  /** Must be an absolute path; relative roots fail explicitly. */
  storage_root: string;
  clock: () => string;
  policy?: Partial<CapturePolicyV1>;
  budget?: ObservationBudgetPortV1;
  fs?: ObservationStorageFsV1;
}

// ---------------------------------------------------------------------------
// Errors and result shapes
// ---------------------------------------------------------------------------

export class ObservationContainmentError extends Error {
  readonly code = 'OBSERVATION_CONTAINMENT';
  constructor(message: string) {
    super(message);
    this.name = 'ObservationContainmentError';
  }
}

export class ObservationUnsupportedGuaranteeError extends Error {
  readonly code = 'OBSERVATION_UNSUPPORTED_GUARANTEE';
  constructor(message: string) {
    super(message);
    this.name = 'ObservationUnsupportedGuaranteeError';
  }
}

export class ObservationCursorError extends Error {
  readonly code = 'OBSERVATION_INVALID_CURSOR';
  constructor(message: string) {
    super(message);
    this.name = 'ObservationCursorError';
  }
}

export type ObservationBlockPolicyV1 =
  | 'data_policy'
  | 'storage_limit'
  | 'containment'
  | 'unsupported_guarantee';

export interface ObservationSectionInputV1 {
  channel: ObservationChannelV1;
  content: string | Uint8Array;
  representation?: ObservationRepresentationV1;
  encoding?: ObservationEncodingV1;
  media_type?: string;
  capture_completeness?: ObservationCompletenessV1;
}

export interface ObservationDataPolicyV1 {
  approved: boolean;
  policy_version: string;
  redaction_policy_version: string;
  reason?: string;
}

export interface CaptureApprovedObservationInputV1 {
  invocation: ObservationInvocationV1;
  sections: readonly ObservationSectionInputV1[];
  execution_status: ObservationExecutionStatusV1;
  permitted_principals: readonly string[];
  data_policy: ObservationDataPolicyV1;
  snapshot_ref?: string;
  coverage_ref?: string;
  /** The currently visible approved observation to retain on any failure. */
  previous_observation?: ObservationRefV1;
}

export type CaptureApprovedObservationResultV1 =
  | {
      status: 'captured';
      observation: ObservationRefV1;
      duplicate_payloads: string[];
      effect_replay_authorized: false;
    }
  | {
      status: 'evidence_degraded';
      reason: string;
      retained_observation: ObservationRefV1 | null;
      durable_observation: ObservationRefV1 | null;
      effect_replay_authorized: false;
    }
  | {
      status: 'blocked';
      reason: string;
      policy: ObservationBlockPolicyV1;
      effect_replay_authorized: false;
    };

export interface CallerContextV1 {
  principal_id: string;
  /** Explicit membership; knowing a SHA or id is not permission. */
  authorized_observation_ids: readonly string[];
  /** Fork/restart inheritance must name an authorized parent principal. */
  inherited_from?: string;
  read_only?: boolean;
}

export type ResolveObservationResultV1 =
  | {
      status: 'resolved';
      observation: ObservationRefV1;
      payloads: ObservationPayloadV1[];
    }
  | { status: 'denied'; reason: string; policy: 'principal' | 'membership' | 'scope' }
  | { status: 'unavailable'; reason: string };

export interface ReadBoundsV1 {
  max_bytes?: number;
}

export type ReadObservationPageResultV1 =
  | {
      status: 'page';
      observation_id: string;
      payload_id: string;
      section: ObservationChannelV1;
      requested_offset: number;
      actual_offset: number;
      byte_offset_basis: 'original_payload_bytes';
      content: string;
      encoding: ObservationEncodingV1;
      representation: ObservationRepresentationV1;
      media_type: string;
      returned_bytes: number;
      next_cursor: string | null;
      eof: boolean;
      source_sha256: string;
      source_byte_length: number;
      capture_completeness: ObservationCompletenessV1;
      requested_max_bytes: number;
      effective_max_bytes: number;
      clamped: boolean;
    }
  | { status: 'denied'; reason: string; policy: 'principal' | 'membership' | 'scope' }
  | { status: 'unavailable'; reason: string };

// ---------------------------------------------------------------------------
// Pure derivation helpers
// ---------------------------------------------------------------------------

export function resolveCapturePolicy(
  overrides: Partial<CapturePolicyV1> = {},
): CapturePolicyV1 {
  return { ...OBSERVATION_CAPTURE_POLICY_DEFAULTS_V1, ...overrides };
}

function invocationIdentity(input: ObservationInvocationV1): Record<string, string> {
  return {
    operation_id: input.operation_id,
    task_id: input.task_id,
    run_id: input.run_id,
    turn_id: input.turn_id ?? '',
    attempt_id: input.attempt_id ?? '',
  };
}

/**
 * Stable invocation-derived observation id. Identical content from distinct
 * invocations produces distinct ids; a retry of the same invocation is stable.
 * The id never depends on sanitised filenames, so `a/b` and `a_b` cannot alias.
 */
export function deriveObservationId(invocation: ObservationInvocationV1): string {
  const digest = sha256Canonical(invocationIdentity(invocation));
  return `obs:${digest}`;
}

export function derivePayloadId(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function payloadObjectKey(sha256: string): string {
  return join('objects', sha256.slice(0, 2), `${sha256}.bin`);
}

function observationRefKey(observationId: string): string {
  const hex = observationId.replace(/^obs:/, '');
  return join('refs', hex.slice(0, 2), `${hex}.json`);
}

const COMPLETENESS_RANK: Record<ObservationCompletenessV1, number> = {
  unknown: 0,
  decoded_upstream: 1,
  truncated_upstream: 2,
  complete: 3,
};

export function aggregateCaptureCompleteness(
  values: readonly ObservationCompletenessV1[],
): ObservationCompletenessV1 {
  if (values.length === 0) return 'unknown';
  let weakest: ObservationCompletenessV1 = 'complete';
  for (const value of values) {
    if (COMPLETENESS_RANK[value] < COMPLETENESS_RANK[weakest]) weakest = value;
  }
  return weakest;
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

function assertAbsoluteRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new ObservationUnsupportedGuaranteeError(
      `observation storage_root must be absolute (received ${JSON.stringify(root)})`,
    );
  }
  return resolve(root);
}

/**
 * Durable default accounting derived from the store itself: total bytes are
 * the sum of stored object files, per-run bytes are the distinct payload
 * lengths referenced by that run's observation refs. `record` is a no-op
 * because usage is recomputed. This is O(store) per capture; production should
 * use a controller-owned counter, but the semantics are durable across restart.
 */
function createStorageBackedObservationBudget(
  fs: ObservationStorageFsV1,
  root: string,
): ObservationBudgetPortV1 {
  return {
    usage(runId: string): ObservationBudgetUsageV1 {
      let total = 0;
      const objectsRoot = join(root, 'objects');
      if (fs.isDirectory(objectsRoot)) {
        for (const prefix of fs.listDirectory(objectsRoot)) {
          const prefixPath = join(objectsRoot, prefix);
          if (!fs.isDirectory(prefixPath)) continue;
          for (const name of fs.listDirectory(prefixPath)) {
            try {
              total += fs.byteLength(join(prefixPath, name));
            } catch {
              // Unreadable stray object stays out of the durable total.
            }
          }
        }
      }
      let runBytes = 0;
      const seen = new Set<string>();
      const refsRoot = join(root, 'refs');
      if (fs.isDirectory(refsRoot)) {
        for (const prefix of fs.listDirectory(refsRoot)) {
          const prefixPath = join(refsRoot, prefix);
          if (!fs.isDirectory(prefixPath)) continue;
          for (const name of fs.listDirectory(prefixPath)) {
            try {
              const raw = new TextDecoder().decode(fs.readFile(join(prefixPath, name)));
              const observation = JSON.parse(raw) as ObservationRefV1;
              if (observation.invocation?.run_id !== runId) continue;
              for (const payload of observation.payloads) {
                if (seen.has(payload.payload_id)) continue;
                seen.add(payload.payload_id);
                runBytes += payload.byte_length;
              }
            } catch {
              // Ignore unreadable refs for accounting; resolve reports them.
            }
          }
        }
      }
      return { run_bytes: runBytes, total_bytes: total };
    },
    record(): void {
      // usage() is derived from durable objects; nothing to accumulate.
    },
  };
}

/**
 * Verify that every existing component from the storage root down to `target`
 * is a real directory/file and not a symlink/reparse point. An ancestor symlink
 * (not just a symlinked filename) is rejected.
 *
 * Ancestors *above* the configured storage root are the controller's trust
 * boundary: this helper does not claim to police them, and a root that is itself
 * a symlink/reparse point fails explicitly rather than being silently followed.
 */
function assertContainedPath(
  fs: ObservationStorageFsV1,
  root: string,
  target: string,
): void {
  if (fs.exists(root) && fs.isSymbolicLink(root)) {
    throw new ObservationContainmentError(
      `observation storage_root is a symlink/reparse point: ${root}`,
    );
  }
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ObservationContainmentError(
      `observation path escapes storage root: ${target}`,
    );
  }
  let current = root;
  for (const part of rel.split(sep).filter((segment) => segment.length > 0)) {
    current = join(current, part);
    if (fs.exists(current) && fs.isSymbolicLink(current)) {
      throw new ObservationContainmentError(
        `observation path crosses a symlink/reparse ancestor: ${current}`,
      );
    }
  }
}

function ensureDirectory(
  fs: ObservationStorageFsV1,
  root: string,
  directory: string,
): void {
  const rel = relative(root, directory);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ObservationContainmentError(
      `observation directory escapes storage root: ${directory}`,
    );
  }
  let current = root;
  for (const part of rel.split(sep).filter((segment) => segment.length > 0)) {
    current = join(current, part);
    if (fs.exists(current) && fs.isSymbolicLink(current)) {
      throw new ObservationContainmentError(
        `observation directory crosses a symlink/reparse ancestor: ${current}`,
      );
    }
    if (!fs.exists(current)) fs.mkdirp(current);
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface PreparedPayloadV1 {
  meta: ObservationPayloadV1;
  bytes: Uint8Array;
}

function sectionBytes(section: ObservationSectionInputV1): {
  bytes: Uint8Array;
  representation: ObservationRepresentationV1;
  encoding: ObservationEncodingV1;
} {
  if (typeof section.content === 'string') {
    return {
      bytes: new TextEncoder().encode(section.content),
      representation: section.representation ?? 'text',
      encoding: section.encoding ?? 'utf8',
    };
  }
  return {
    bytes: section.content,
    representation: section.representation ?? 'binary',
    encoding: section.encoding ?? 'base64',
  };
}

function preparePayload(
  section: ObservationSectionInputV1,
  policy: CapturePolicyV1,
): PreparedPayloadV1 {
  const { bytes, representation, encoding } = sectionBytes(section);
  const sha256 = sha256Hex(bytes);
  return {
    bytes,
    meta: {
      payload_id: `sha256:${sha256}`,
      sha256,
      byte_length: bytes.byteLength,
      representation,
      encoding,
      channel: section.channel,
      media_type: section.media_type ?? 'application/octet-stream',
      capture_policy_version: policy.policy_version,
      redaction_policy_version: policy.redaction_policy_version,
      capture_completeness: section.capture_completeness ?? 'complete',
      object_key: payloadObjectKey(sha256),
    },
  };
}

function classifyStorageFailure(error: unknown): { code: string; storage_limit: boolean } {
  const code = nodeErrorCode(error) ?? 'UNKNOWN';
  return { code, storage_limit: code === 'ENOSPC' || code === 'EDQUOT' };
}

function degraded(
  reason: string,
  retained: ObservationRefV1 | null,
  durable: ObservationRefV1 | null,
): CaptureApprovedObservationResultV1 {
  return {
    status: 'evidence_degraded',
    reason,
    retained_observation: retained,
    durable_observation: durable,
    effect_replay_authorized: false,
  };
}

function blocked(reason: string, policy: ObservationBlockPolicyV1): CaptureApprovedObservationResultV1 {
  return { status: 'blocked', reason, policy, effect_replay_authorized: false };
}

/**
 * Persist an approved executor result. The executor has already run; this
 * function never executes a command and never authorizes replay.
 */
export function captureApprovedObservation(
  input: CaptureApprovedObservationInputV1,
  storage: ObservationStorageContextV1,
): CaptureApprovedObservationResultV1 {
  const retained = input.previous_observation ?? null;
  const policy = resolveCapturePolicy(storage.policy);
  const fs = storage.fs ?? createNodeObservationFs();

  if (!input.data_policy.approved) {
    return blocked(
      input.data_policy.reason ?? 'data policy did not approve model-readable persistence',
      'data_policy',
    );
  }
  if (input.permitted_principals.length === 0) {
    return blocked('capture requires at least one permitted principal', 'data_policy');
  }

  let root: string;
  try {
    root = assertAbsoluteRoot(storage.storage_root);
  } catch (error) {
    if (error instanceof ObservationUnsupportedGuaranteeError) {
      return blocked(error.message, 'unsupported_guarantee');
    }
    if (error instanceof ObservationContainmentError) {
      return blocked(error.message, 'containment');
    }
    throw error;
  }

  for (const section of input.sections) {
    const { bytes } = sectionBytes(section);
    if (
      section.channel === 'stderr' &&
      typeof section.content === 'string' &&
      isCredentialDeniedOutput(section.content)
    ) {
      return blocked(
        'credential-denied output is never archived under an approved capture',
        'data_policy',
      );
    }
    if (bytes.byteLength > policy.max_object_bytes) {
      return blocked(
        `section ${section.channel} is ${bytes.byteLength} bytes and exceeds per-object limit ${policy.max_object_bytes}`,
        'storage_limit',
      );
    }
  }

  const prepared = input.sections.map((section) => preparePayload(section, policy));
  const budget = storage.budget ?? createStorageBackedObservationBudget(fs, root);

  try {
    assertContainedPath(fs, root, join(root, 'refs'));
  } catch (error) {
    if (error instanceof ObservationContainmentError) {
      return blocked(error.message, 'containment');
    }
    throw error;
  }

  // Conservative pre-write budget projection (dedupe is verified below).
  const usage = budget.usage(input.invocation.run_id);
  const candidateBytes = prepared.reduce((sum, item) => sum + item.meta.byte_length, 0);
  if (usage.run_bytes + candidateBytes > policy.max_run_bytes) {
    return blocked(
      `run ${input.invocation.run_id} would exceed per-run write limit ${policy.max_run_bytes}`,
      'storage_limit',
    );
  }
  if (usage.total_bytes + candidateBytes > policy.max_total_bytes) {
    return blocked(
      `total write limit ${policy.max_total_bytes} would be exceeded`,
      'storage_limit',
    );
  }

  const duplicatePayloads: string[] = [];
  const newlyWrittenBytes = new Map<string, number>();

  for (const item of prepared) {
    const objectPath = join(root, item.meta.object_key);
    try {
      ensureDirectory(fs, root, dirname(objectPath));
      fs.writeFileExclusive(objectPath, item.bytes, 0o600);
      newlyWrittenBytes.set(item.meta.payload_id, item.meta.byte_length);
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        // Check existing object size/hash before reuse.
        try {
          if (!fs.isFile(objectPath)) {
            return degraded(
              `existing payload object is not a regular file: ${item.meta.object_key}`,
              retained,
              null,
            );
          }
          if (fs.byteLength(objectPath) !== item.meta.byte_length) {
            return degraded(
              `existing payload object size mismatch: ${item.meta.object_key}`,
              retained,
              null,
            );
          }
          const existing = fs.readFile(objectPath);
          if (sha256Hex(existing) !== item.meta.sha256) {
            return degraded(
              `existing payload object hash mismatch: ${item.meta.object_key}`,
              retained,
              null,
            );
          }
          duplicatePayloads.push(item.meta.payload_id);
        } catch (verifyError) {
          const { code } = classifyStorageFailure(verifyError);
          return degraded(
            `payload integrity verification failed (${code}): ${item.meta.object_key}`,
            retained,
            null,
          );
        }
        continue;
      }
      const { code, storage_limit } = classifyStorageFailure(error);
      if (error instanceof ObservationContainmentError) {
        return blocked(error.message, 'containment');
      }
      return degraded(
        `payload write failed (${code})${storage_limit ? ' [storage limit]' : ''}: ${item.meta.object_key}`,
        retained,
        null,
      );
    }
  }

  const observationId = deriveObservationId(input.invocation);
  const observation: ObservationRefV1 = {
    schema_version: OBSERVATION_STORE_SCHEMA_VERSION,
    observation_id: observationId,
    invocation: { ...input.invocation },
    payloads: prepared.map((item) => ({ ...item.meta })),
    execution_status: input.execution_status,
    ...(input.snapshot_ref !== undefined ? { snapshot_ref: input.snapshot_ref } : {}),
    ...(input.coverage_ref !== undefined ? { coverage_ref: input.coverage_ref } : {}),
    capture_completeness: aggregateCaptureCompleteness(
      prepared.map((item) => item.meta.capture_completeness),
    ),
    permitted_principals: [...input.permitted_principals],
    capture_policy_version: policy.policy_version,
    redaction_policy_version: policy.redaction_policy_version,
    captured_at: storage.clock(),
  };

  const refPath = join(root, observationRefKey(observationId));
  const refBytes = new TextEncoder().encode(`${canonicalJson(observation)}\n`);
  try {
    ensureDirectory(fs, root, dirname(refPath));
    fs.writeFileExclusive(refPath, refBytes, 0o600);
  } catch (error) {
    if (nodeErrorCode(error) === 'EEXIST') {
      try {
        const existingRaw = new TextDecoder().decode(fs.readFile(refPath));
        const existing = JSON.parse(existingRaw) as ObservationRefV1;
        if (canonicalJson(existing) !== canonicalJson(observation)) {
          return degraded(
            `invocation reference already exists with different content: ${observationId}`,
            retained,
            null,
          );
        }
        return {
          status: 'captured',
          observation: existing,
          duplicate_payloads: prepared.map((item) => item.meta.payload_id),
          effect_replay_authorized: false,
        };
      } catch {
        return degraded(`invocation reference is unreadable: ${observationId}`, retained, null);
      }
    }
    const { code } = classifyStorageFailure(error);
    return degraded(`invocation reference write failed (${code})`, retained, null);
  }

  // Durability: fsync file + directory when claimed.
  if (policy.durability === 'fsync_file_and_dir') {
    try {
      fs.syncFile(refPath);
      fs.syncDir(dirname(refPath));
      for (const item of prepared) {
        if (newlyWrittenBytes.has(item.meta.payload_id)) {
          const objectPath = join(root, item.meta.object_key);
          fs.syncFile(objectPath);
          fs.syncDir(dirname(objectPath));
        }
      }
    } catch (error) {
      const { code } = classifyStorageFailure(error);
      return degraded(
        `durability sync unsupported or failed (${code}); ref is present but not claimed durable`,
        retained,
        observation,
      );
    }
  }

  try {
    for (const [payloadId, bytes] of newlyWrittenBytes) {
      void payloadId;
      budget.record(input.invocation.run_id, bytes);
    }
  } catch (error) {
    const code = nodeErrorCode(error) ?? 'UNKNOWN';
    return degraded(
      `budget accounting failed (${code}); ref is present but write accounting is uncertain`,
      retained,
      observation,
    );
  }

  return {
    status: 'captured',
    observation,
    duplicate_payloads: duplicatePayloads,
    effect_replay_authorized: false,
  };
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

function authorizeCaller(
  observation: ObservationRefV1,
  caller: CallerContextV1,
): ResolveObservationResultV1 | { authorized: true } {
  const permitted = observation.permitted_principals;
  const principalKnown =
    permitted.includes(caller.principal_id) ||
    (caller.inherited_from !== undefined && permitted.includes(caller.inherited_from));
  if (!principalKnown) {
    return {
      status: 'denied',
      reason: `principal ${caller.principal_id} is not a permitted principal`,
      policy: 'principal',
    };
  }
  if (!caller.authorized_observation_ids.includes(observation.observation_id)) {
    return {
      status: 'denied',
      reason: 'observation reference is not in the caller authorized membership',
      policy: 'membership',
    };
  }
  return { authorized: true };
}

function loadObservation(
  ref: string | { observation_id: string },
  storage: ObservationStorageContextV1,
): { ok: true; observation: ObservationRefV1 } | { ok: false; result: ResolveObservationResultV1 } {
  const observationId = typeof ref === 'string' ? ref : ref.observation_id;
  if (!/^obs:[0-9a-f]{64}$/.test(observationId)) {
    return {
      ok: false,
      result: {
        status: 'unavailable',
        reason: 'observation reference is not a valid stable invocation id',
      },
    };
  }
  const fs = storage.fs ?? createNodeObservationFs();
  let root: string;
  try {
    root = assertAbsoluteRoot(storage.storage_root);
    assertContainedPath(fs, root, join(root, 'refs'));
  } catch (error) {
    return {
      ok: false,
      result: {
        status: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const refPath = join(root, observationRefKey(observationId));
  if (!fs.isFile(refPath)) {
    return {
      ok: false,
      result: {
        status: 'unavailable',
        reason: 'observation reference is unknown or was deleted; it stays explicitly unresolved',
      },
    };
  }
  try {
    const observation = JSON.parse(new TextDecoder().decode(fs.readFile(refPath))) as ObservationRefV1;
    if (observation.observation_id !== observationId) {
      return {
        ok: false,
        result: { status: 'unavailable', reason: 'observation reference identity mismatch' },
      };
    }
    return { ok: true, observation };
  } catch {
    return {
      ok: false,
      result: { status: 'unavailable', reason: 'observation reference is unreadable' },
    };
  }
}

function verifyPayloadIntegrity(
  payload: ObservationPayloadV1,
  storage: ObservationStorageContextV1,
  root: string,
): { ok: true } | { ok: false; reason: string } {
  const fs = storage.fs ?? createNodeObservationFs();
  const objectPath = join(root, payload.object_key);
  if (!fs.isFile(objectPath)) return { ok: false, reason: `payload object missing: ${payload.object_key}` };
  if (fs.byteLength(objectPath) !== payload.byte_length) {
    return { ok: false, reason: `payload object size mismatch: ${payload.object_key}` };
  }
  try {
    const bytes = fs.readFile(objectPath);
    if (sha256Hex(bytes) !== payload.sha256) {
      return { ok: false, reason: `payload object hash mismatch: ${payload.object_key}` };
    }
  } catch {
    return { ok: false, reason: `payload object unreadable: ${payload.object_key}` };
  }
  return { ok: true };
}

export function resolveObservation(
  ref: string | { observation_id: string },
  caller: CallerContextV1,
  storage: ObservationStorageContextV1,
): ResolveObservationResultV1 {
  const loaded = loadObservation(ref, storage);
  if (!loaded.ok) return loaded.result;
  const authorized = authorizeCaller(loaded.observation, caller);
  if ('status' in authorized) return authorized;
  const root = assertAbsoluteRoot(storage.storage_root);
  for (const payload of loaded.observation.payloads) {
    const integrity = verifyPayloadIntegrity(payload, storage, root);
    if (!integrity.ok) return { status: 'unavailable', reason: integrity.reason };
  }
  return {
    status: 'resolved',
    observation: loaded.observation,
    payloads: loaded.observation.payloads.map((payload) => ({ ...payload })),
  };
}

// ---------------------------------------------------------------------------
// Bounded page reads
// ---------------------------------------------------------------------------

function encodeCursor(offset: number): string {
  return `v1:${offset}`;
}

function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === '') return 0;
  const match = /^v1:(\d+)$/.exec(cursor);
  if (!match) throw new ObservationCursorError(`invalid cursor: ${JSON.stringify(cursor)}`);
  return Number(match[1]);
}

function utf8StartBoundary(bytes: Uint8Array, offset: number): number {
  let cursor = offset;
  while (cursor < bytes.byteLength) {
    const byte = bytes[cursor] ?? 0;
    if ((byte & 0xc0) !== 0x80) break;
    cursor++;
  }
  return cursor;
}

function utf8EndBoundary(bytes: Uint8Array, start: number, end: number): number {
  let cursor = end;
  while (cursor > start) {
    const byte = bytes[cursor] ?? 0;
    if ((byte & 0xc0) !== 0x80) break;
    cursor--;
  }
  if (cursor <= start) {
    // Advance one whole code point so a valid cursor always makes progress.
    const first = bytes[start];
    if (first === undefined) return start;
    const length = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    return Math.min(start + length, bytes.byteLength);
  }
  return cursor;
}

export function readObservationPage(
  ref: string | { observation_id: string },
  cursor: string | null,
  bounds: ReadBoundsV1,
  caller: CallerContextV1,
  storage: ObservationStorageContextV1,
  sectionFilter?: ObservationChannelV1,
): ReadObservationPageResultV1 {
  const resolved = resolveObservation(ref, caller, storage);
  if (resolved.status !== 'resolved') return resolved;

  const section = sectionFilter
    ? resolved.observation.payloads.find((payload) => payload.channel === sectionFilter)
    : boundsSection(resolved.observation);
  if (!section) {
    return {
      status: 'unavailable',
      reason: 'observation has no stdout/stderr/structured payload to page over',
    };
  }

  const policy = resolveCapturePolicy(storage.policy);
  const requestedMax = bounds.max_bytes ?? policy.page_bytes_default;
  if (!Number.isFinite(requestedMax) || requestedMax <= 0) {
    throw new ObservationCursorError(`max_bytes must be a positive integer; received ${String(bounds.max_bytes)}`);
  }
  const effectiveMax = Math.min(Math.floor(requestedMax), policy.page_bytes_max);
  const clamped = effectiveMax !== Math.floor(requestedMax);

  let requestedOffset: number;
  try {
    requestedOffset = decodeCursor(cursor);
  } catch (error) {
    if (error instanceof ObservationCursorError) {
      throw error;
    }
    throw error;
  }

  const fs = storage.fs ?? createNodeObservationFs();
  const root = assertAbsoluteRoot(storage.storage_root);
  const bytes = fs.readFile(join(root, section.object_key));
  const size = bytes.byteLength;

  if (requestedOffset < 0) {
    throw new ObservationCursorError(`cursor offset must be non-negative: ${requestedOffset}`);
  }

  let actualOffset: number;
  let end: number;
  if (requestedOffset >= size) {
    actualOffset = size;
    end = size;
  } else if (section.encoding === 'utf8' && section.representation === 'text') {
    actualOffset = utf8StartBoundary(bytes, requestedOffset);
    const preliminaryEnd = Math.min(actualOffset + effectiveMax, size);
    end = preliminaryEnd >= size ? size : utf8EndBoundary(bytes, actualOffset, preliminaryEnd);
    if (end <= actualOffset) end = utf8EndBoundary(bytes, actualOffset, size);
  } else {
    actualOffset = requestedOffset;
    end = Math.min(requestedOffset + effectiveMax, size);
  }

  const slice = bytes.subarray(actualOffset, end);
  const content =
    section.encoding === 'utf8'
      ? new TextDecoder('utf-8', { fatal: false }).decode(slice)
      : Buffer.from(slice).toString('base64');
  const eof = end >= size;
  return {
    status: 'page',
    observation_id: resolved.observation.observation_id,
    payload_id: section.payload_id,
    section: section.channel,
    requested_offset: requestedOffset,
    actual_offset: actualOffset,
    byte_offset_basis: 'original_payload_bytes',
    content,
    encoding: section.encoding,
    representation: section.representation,
    media_type: section.media_type,
    returned_bytes: slice.byteLength,
    next_cursor: eof ? null : encodeCursor(end),
    eof,
    source_sha256: section.sha256,
    source_byte_length: size,
    capture_completeness: section.capture_completeness,
    requested_max_bytes: Math.floor(requestedMax),
    effective_max_bytes: effectiveMax,
    clamped,
  };
}

function boundsSection(observation: ObservationRefV1): ObservationPayloadV1 | undefined {
  for (const channel of ['stdout', 'stderr', 'structured', 'summary', 'checkpoint'] as const) {
    const found = observation.payloads.find((payload) => payload.channel === channel);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure projection
// ---------------------------------------------------------------------------

export interface ProjectionSnapshotV1 {
  schema_version: typeof OBSERVATION_STORE_SCHEMA_VERSION;
  policy_version: string;
  context_epoch: number;
  logical_request_id: string;
  /** Candidate observation ids for this logical request. */
  observation_ref_set: readonly string[];
  exposure_state: Readonly<Record<string, 'unexposed' | 'exposed' | 'unknown'>>;
  budget_bytes: number;
}

export interface ProjectedObservationV1 {
  observation_id: string;
  invocation: ObservationInvocationV1;
  payload_refs: ObservationPayloadV1[];
  byte_length: number;
  execution_status: ObservationExecutionStatusV1;
  capture_completeness: ObservationCompletenessV1;
}

export interface ProjectionResultV1 {
  schema_version: typeof OBSERVATION_STORE_SCHEMA_VERSION;
  policy_version: string;
  context_epoch: number;
  logical_request_id: string;
  request_fingerprint: string;
  selected: ProjectedObservationV1[];
  omitted: Array<{ observation_id: string; reason: 'policy_excluded' | 'budget_exceeded' | 'already_exposed' }>;
  unresolved: Array<{ observation_id: string; reason: 'unavailable' | 'unknown_history' }>;
  total_bytes: number;
  mutated: false;
}

export interface ProjectObservationsOptionsV1 {
  /** ids known to be durably available; others are explicitly unresolved. */
  available_observation_ids: readonly string[];
}

/**
 * Pure model-visible selection. No file writes, random ids, clocks or global
 * send counters; the same inputs always produce the same projection. Objects
 * must already be durably available before omission.
 */
export function projectObservations(
  history: readonly ObservationRefV1[],
  snapshot: ProjectionSnapshotV1,
  options: ProjectObservationsOptionsV1,
): ProjectionResultV1 {
  const available = new Set(options.available_observation_ids);
  const byId = new Map(history.map((item) => [item.observation_id, item]));
  const requested = [...snapshot.observation_ref_set];

  const selected: ProjectedObservationV1[] = [];
  const omitted: ProjectionResultV1['omitted'] = [];
  const unresolved: ProjectionResultV1['unresolved'] = [];
  let totalBytes = 0;

  // Deterministic ordering independent of caller array order.
  for (const observationId of [...requested].sort()) {
    const observation = byId.get(observationId);
    if (!observation) {
      unresolved.push({ observation_id: observationId, reason: 'unknown_history' });
      continue;
    }
    if (!available.has(observationId)) {
      unresolved.push({ observation_id: observationId, reason: 'unavailable' });
      continue;
    }
    const exposure = snapshot.exposure_state[observationId];
    if (exposure === 'exposed') {
      omitted.push({ observation_id: observationId, reason: 'already_exposed' });
      continue;
    }
    const byteLength = observation.payloads.reduce((sum, payload) => sum + payload.byte_length, 0);
    if (totalBytes + byteLength > snapshot.budget_bytes) {
      omitted.push({ observation_id: observationId, reason: 'budget_exceeded' });
      continue;
    }
    totalBytes += byteLength;
    selected.push({
      observation_id: observation.observation_id,
      invocation: { ...observation.invocation },
      payload_refs: observation.payloads.map((payload) => ({ ...payload })),
      byte_length: byteLength,
      execution_status: observation.execution_status,
      capture_completeness: observation.capture_completeness,
    });
  }

  const fingerprint = sha256Canonical({
    policy_version: snapshot.policy_version,
    context_epoch: snapshot.context_epoch,
    logical_request_id: snapshot.logical_request_id,
    observation_ref_set: [...requested].sort(),
    exposure_state: Object.fromEntries(
      Object.entries(snapshot.exposure_state).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  });

  return {
    schema_version: OBSERVATION_STORE_SCHEMA_VERSION,
    policy_version: snapshot.policy_version,
    context_epoch: snapshot.context_epoch,
    logical_request_id: snapshot.logical_request_id,
    request_fingerprint: fingerprint,
    selected,
    omitted,
    unresolved,
    total_bytes: totalBytes,
    mutated: false,
  };
}

// Re-exported so callers can enumerate stored objects for conservative cleanup
// planning without adding a GC project here.
export function listStoredPayloadObjects(
  storage: ObservationStorageContextV1,
): string[] {
  const fs = storage.fs ?? createNodeObservationFs();
  const root = assertAbsoluteRoot(storage.storage_root);
  const objectsRoot = join(root, 'objects');
  if (!fs.isDirectory(objectsRoot)) return [];
  const results: string[] = [];
  for (const prefix of fs.listDirectory(objectsRoot)) {
    const prefixPath = join(objectsRoot, prefix);
    if (!fs.isDirectory(prefixPath)) continue;
    for (const name of fs.listDirectory(prefixPath)) {
      results.push(join('objects', prefix, name));
    }
  }
  return results.sort();
}

/**
 * Signed, redacted workspace-readiness contract for provider-backed runs.
 *
 * The receipt is intentionally metadata-only: it carries digests and boolean
 * readiness facts, never paths, prompts, credentials, or command output. A
 * launcher creates it after local preflight; ChatEngine verifies it before it
 * resolves a provider runner when the launcher enables the guard.
 */

import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { resolve } from 'node:path';

export const WORKSPACE_READINESS_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_READINESS_KIND = 'babel_workspace_readiness' as const;

export type WorkspaceReadinessAuthority = 'dataset_bound' | 'project_bound' | 'none';

export interface WorkspaceReadinessReceipt {
  schema_version: typeof WORKSPACE_READINESS_SCHEMA_VERSION;
  kind: typeof WORKSPACE_READINESS_KIND;
  receipt_id: string;
  workspace_root_sha256: string;
  verifier_root_sha256: string | null;
  git_head_sha256: string | null;
  test_path_sha256: string | null;
  verifier_command_sha256: string | null;
  dependency_ready: boolean;
  python_executable_valid: boolean | null;
  collection_ready: boolean | null;
  test_patch_applied: boolean | null;
  verifier_authority: WorkspaceReadinessAuthority;
  created_at: string;
  signature: string;
}

export interface WorkspaceReadinessSigner {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyBase64: string;
}

export interface WorkspaceReadinessInput {
  workspaceRoot: string;
  verifierRoot?: string | null;
  gitHead?: string | null;
  testPath?: string | null;
  verifierCommand?: string | null;
  dependencyReady: boolean;
  pythonExecutableValid?: boolean | null;
  collectionReady?: boolean | null;
  testPatchApplied?: boolean | null;
  verifierAuthority?: WorkspaceReadinessAuthority;
  createdAt?: string;
}

export interface WorkspaceReadinessValidation {
  ok: boolean;
  reason: string | null;
  receipt?: WorkspaceReadinessReceipt;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestPath(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = resolve(value).replace(/\\/g, '/').toLowerCase();
  return sha256(normalized);
}

function digestText(value: string | null | undefined): string | null {
  return value?.trim() ? sha256(value.trim()) : null;
}

function unsignedReceipt(receipt: WorkspaceReadinessReceipt): Omit<WorkspaceReadinessReceipt, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function receiptIdPayload(receipt: Omit<WorkspaceReadinessReceipt, 'receipt_id' | 'signature'>): string {
  return canonicalJson(receipt);
}

export function createWorkspaceReadinessSigner(): WorkspaceReadinessSigner {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyBase64 = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    publicKeyBase64,
  };
}

export function createWorkspaceReadinessReceipt(
  input: WorkspaceReadinessInput,
  signer: WorkspaceReadinessSigner,
): WorkspaceReadinessReceipt {
  const base: Omit<WorkspaceReadinessReceipt, 'receipt_id' | 'signature'> = {
    schema_version: WORKSPACE_READINESS_SCHEMA_VERSION,
    kind: WORKSPACE_READINESS_KIND,
    workspace_root_sha256: digestPath(input.workspaceRoot)!,
    verifier_root_sha256: digestPath(input.verifierRoot),
    git_head_sha256: digestText(input.gitHead),
    test_path_sha256: digestText(input.testPath),
    verifier_command_sha256: digestText(input.verifierCommand),
    dependency_ready: input.dependencyReady,
    python_executable_valid: input.pythonExecutableValid ?? null,
    collection_ready: input.collectionReady ?? null,
    test_patch_applied: input.testPatchApplied ?? null,
    verifier_authority: input.verifierAuthority ?? 'none',
    created_at: input.createdAt ?? new Date().toISOString(),
  };
  const receipt_id = sha256(receiptIdPayload(base)).slice(0, 32);
  const unsigned = { ...base, receipt_id } as Omit<WorkspaceReadinessReceipt, 'signature'>;
  const signature = sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), signer.privateKey).toString('base64url');
  return { ...unsigned, signature };
}

export function encodeWorkspaceReadinessReceipt(receipt: WorkspaceReadinessReceipt): string {
  return Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url');
}

export function decodeWorkspaceReadinessReceipt(value: string): WorkspaceReadinessReceipt | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return isWorkspaceReadinessReceiptShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isWorkspaceReadinessReceiptShape(value: unknown): value is WorkspaceReadinessReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r['schema_version'] === WORKSPACE_READINESS_SCHEMA_VERSION &&
    r['kind'] === WORKSPACE_READINESS_KIND &&
    typeof r['receipt_id'] === 'string' &&
    /^[a-f0-9]{32}$/.test(r['receipt_id']) &&
    typeof r['workspace_root_sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(r['workspace_root_sha256']) &&
    (r['verifier_root_sha256'] === null || typeof r['verifier_root_sha256'] === 'string') &&
    (r['git_head_sha256'] === null || typeof r['git_head_sha256'] === 'string') &&
    (r['test_path_sha256'] === null || typeof r['test_path_sha256'] === 'string') &&
    (r['verifier_command_sha256'] === null || typeof r['verifier_command_sha256'] === 'string') &&
    typeof r['dependency_ready'] === 'boolean' &&
    (r['python_executable_valid'] === null || typeof r['python_executable_valid'] === 'boolean') &&
    (r['collection_ready'] === null || typeof r['collection_ready'] === 'boolean') &&
    (r['test_patch_applied'] === null || typeof r['test_patch_applied'] === 'boolean') &&
    (r['verifier_authority'] === 'dataset_bound' ||
      r['verifier_authority'] === 'project_bound' ||
      r['verifier_authority'] === 'none') &&
    typeof r['created_at'] === 'string' &&
    typeof r['signature'] === 'string' &&
    r['signature'].length > 0
  );
}

export function verifyWorkspaceReadinessReceipt(input: {
  receipt: unknown;
  publicKeyBase64: string | undefined;
  expectedWorkspaceRoot?: string;
}): WorkspaceReadinessValidation {
  if (!isWorkspaceReadinessReceiptShape(input.receipt)) {
    return { ok: false, reason: 'receipt_schema_invalid' };
  }
  if (!input.publicKeyBase64?.trim()) {
    return { ok: false, reason: 'receipt_public_key_missing' };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(input.publicKeyBase64, 'base64'),
      type: 'spki',
      format: 'der',
    });
  } catch {
    return { ok: false, reason: 'receipt_public_key_invalid' };
  }

  const unsigned = unsignedReceipt(input.receipt);
  const { receipt_id: actualReceiptId, ...idBase } = unsigned;
  const expectedId = sha256(receiptIdPayload(idBase)).slice(0, 32);
  if (actualReceiptId !== expectedId) {
    return { ok: false, reason: 'receipt_id_mismatch' };
  }
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      publicKey,
      Buffer.from(input.receipt.signature, 'base64url'),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: 'receipt_signature_invalid' };

  if (
    input.expectedWorkspaceRoot &&
    input.receipt.workspace_root_sha256 !== digestPath(input.expectedWorkspaceRoot)
  ) {
    return { ok: false, reason: 'receipt_workspace_mismatch' };
  }
  if (!input.receipt.dependency_ready) return { ok: false, reason: 'workspace_not_dependency_ready' };
  if (input.receipt.python_executable_valid === false) {
    return { ok: false, reason: 'workspace_python_not_executable' };
  }
  if (input.receipt.collection_ready === false) return { ok: false, reason: 'workspace_tests_do_not_collect' };

  return { ok: true, reason: null, receipt: input.receipt };
}

export function loadWorkspaceReadinessFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { receipt: WorkspaceReadinessReceipt | null; publicKeyBase64?: string; reason: string | null } {
  const encoded = env['BABEL_WORKSPACE_READINESS_RECEIPT']?.trim();
  if (!encoded) return { receipt: null, reason: 'receipt_missing' };
  const receipt = decodeWorkspaceReadinessReceipt(encoded);
  if (!receipt) return { receipt: null, reason: 'receipt_encoding_invalid' };
  const publicKeyBase64 = env['BABEL_WORKSPACE_READINESS_PUBLIC_KEY']?.trim();
  return {
    receipt,
    ...(publicKeyBase64 ? { publicKeyBase64 } : {}),
    reason: null,
  };
}

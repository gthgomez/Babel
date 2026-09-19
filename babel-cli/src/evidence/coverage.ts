/**
 * P07 — explicit revision coverage (ADR-004).
 *
 * A digest binds a *scoped claim*, never an entire-workspace certificate. This
 * module makes the declared scope, its completeness, exclusions, baseline and
 * bounded-capture limits explicit so clients can tell "verified these files"
 * apart from "verified everything". It never widens a claim: unknown or
 * partial coverage stays unknown/partial.
 *
 * Read-only and authority-free: it neither scans a workspace nor promotes
 * evidence. Callers supply the observations; this module only describes them.
 */

import { z } from 'zod';

import { sha256Canonical } from '../acceptance/canonical.js';

/** Version of the coverage-manifest contract. */
export const COVERAGE_MANIFEST_SCHEMA_VERSION = 1 as const;

/** Discriminant for the persisted coverage-manifest document. */
export const COVERAGE_MANIFEST_KIND = 'coverage_manifest_v1' as const;

/** How completely the declared scope was captured. */
export type CoverageCompleteness = 'complete' | 'partial' | 'unknown';

/** The declared scope a digest is a claim about. `unknown` covers legacy runs. */
export type CoverageScopeV1 =
  | { kind: 'files'; paths: string[] }
  | { kind: 'repository' }
  | { kind: 'unknown' };

/** Why a path was not part of the captured evidence. */
export type CoverageExclusionReason =
  | 'bounded_capture'
  | 'unreadable'
  | 'skipped'
  | 'credential'
  | 'declared';

export interface CoverageExclusionV1 {
  path: string;
  reason: CoverageExclusionReason;
}

/** The bounded-capture limits that produced the exclusion set. */
export interface CoverageLimitsV1 {
  max_files: number;
  max_file_bytes: number;
  capture_strategy: string;
}

/** The baseline the scope is declared against; a dirty tree is explicit. */
export interface CoverageBaselineV1 {
  git_commit_hash: string | null;
  git_binding: 'required' | 'optional' | 'none';
  dirty: boolean;
  untracked: string[];
}

/** Non-identifying environment identity (no host/user names, no secrets). */
export interface CoverageEnvironmentV1 {
  platform: string;
  arch: string;
  node_version: string;
}

export interface CoverageManifestV1 {
  schema_version: typeof COVERAGE_MANIFEST_SCHEMA_VERSION;
  kind: typeof COVERAGE_MANIFEST_KIND;
  scope: CoverageScopeV1;
  completeness: CoverageCompleteness;
  exclusions: CoverageExclusionV1[];
  limits: CoverageLimitsV1;
  baseline: CoverageBaselineV1;
  environment: CoverageEnvironmentV1;
  captured_at: number;
  /** Optional human note; never used as authority. */
  note?: string;
  /** sha256 over this manifest with `coverage_digest` omitted. */
  coverage_digest: string;
}

export interface CoverageCaptureInputV1 {
  scope: CoverageScopeV1;
  exclusions?: readonly CoverageExclusionV1[];
  limits: CoverageLimitsV1;
  baseline: CoverageBaselineV1;
  environment?: CoverageEnvironmentV1;
  captured_at?: number;
  note?: string;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const scopeSchema = z.union([
  z
    .object({
      kind: z.literal('files'),
      paths: z.array(z.string().min(1)),
    })
    .strict(),
  z.object({ kind: z.literal('repository') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);

const exclusionSchema = z
  .object({
    path: z.string().min(1),
    reason: z.enum([
      'bounded_capture',
      'unreadable',
      'skipped',
      'credential',
      'declared',
    ]),
  })
  .strict();

export const CoverageManifestSchema = z
  .object({
    schema_version: z.literal(COVERAGE_MANIFEST_SCHEMA_VERSION),
    kind: z.literal(COVERAGE_MANIFEST_KIND),
    scope: scopeSchema,
    completeness: z.enum(['complete', 'partial', 'unknown']),
    exclusions: z.array(exclusionSchema),
    limits: z
      .object({
        max_files: z.number().int().nonnegative(),
        max_file_bytes: z.number().int().nonnegative(),
        capture_strategy: z.string().min(1),
      })
      .strict(),
    baseline: z
      .object({
        git_commit_hash: z.string().min(1).nullable(),
        git_binding: z.enum(['required', 'optional', 'none']),
        dirty: z.boolean(),
        untracked: z.array(z.string().min(1)),
      })
      .strict(),
    environment: z
      .object({
        platform: z.string().min(1),
        arch: z.string().min(1),
        node_version: z.string().min(1),
      })
      .strict(),
    captured_at: z.number().int().finite().nonnegative(),
    note: z.string().min(1).optional(),
    coverage_digest: sha256,
  })
  .strict();

export function defaultCoverageEnvironment(): CoverageEnvironmentV1 {
  return {
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
  };
}

function canonicalScope(scope: CoverageScopeV1): CoverageScopeV1 {
  if (scope.kind === 'files') {
    const unique = new Set<string>();
    for (const raw of scope.paths) {
      const normalized = String(raw).replaceAll('\\', '/');
      if (normalized.trim().length === 0)
        throw new Error('Coverage scope path must not be empty.');
      unique.add(normalized);
    }
    return { kind: 'files', paths: [...unique].sort() };
  }
  return scope;
}

function canonicalExclusions(
  exclusions: readonly CoverageExclusionV1[],
): CoverageExclusionV1[] {
  return exclusions
    .map((exclusion) => ({
      path: exclusion.path.replaceAll('\\', '/'),
      reason: exclusion.reason,
    }))
    .sort((left, right) =>
      left.path === right.path
        ? left.reason < right.reason
          ? -1
          : left.reason > right.reason
            ? 1
            : 0
        : left.path < right.path
          ? -1
          : 1,
    );
}

/** Digest of a manifest body (everything except `coverage_digest`). */
export function coverageManifestDigest(
  manifest: Omit<CoverageManifestV1, 'coverage_digest'>,
): string {
  return sha256Canonical(manifest);
}

/** Build an explicit, immutable coverage manifest from observed capture facts. */
export function buildCoverageManifest(
  input: CoverageCaptureInputV1,
): CoverageManifestV1 {
  const exclusions = canonicalExclusions(input.exclusions ?? []);
  return finalizeCoverageManifest({
    schema_version: COVERAGE_MANIFEST_SCHEMA_VERSION,
    kind: COVERAGE_MANIFEST_KIND,
    scope: canonicalScope(input.scope),
    completeness: exclusions.length > 0 ? 'partial' : 'complete',
    exclusions,
    limits: {
      max_files: input.limits.max_files,
      max_file_bytes: input.limits.max_file_bytes,
      capture_strategy: input.limits.capture_strategy,
    },
    baseline: {
      git_commit_hash: input.baseline.git_commit_hash,
      git_binding: input.baseline.git_binding,
      dirty: input.baseline.dirty,
      untracked: [...input.baseline.untracked].sort(),
    },
    environment: input.environment ?? defaultCoverageEnvironment(),
    captured_at: input.captured_at ?? Date.now(),
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
}

/** Attach the self-describing digest to a manifest body. */
function finalizeCoverageManifest(
  body: Omit<CoverageManifestV1, 'coverage_digest'>,
): CoverageManifestV1 {
  return { ...body, coverage_digest: coverageManifestDigest(body) };
}

/**
 * Coverage for evidence that predates coverage manifests. It is explicitly
 * unknown: it never acquires stronger authority retroactively.
 */
export function unknownCoverageManifest(
  note = 'coverage_not_declared',
  captured_at = Date.now(),
): CoverageManifestV1 {
  return finalizeCoverageManifest({
    schema_version: COVERAGE_MANIFEST_SCHEMA_VERSION,
    kind: COVERAGE_MANIFEST_KIND,
    scope: { kind: 'unknown' },
    completeness: 'unknown',
    exclusions: [],
    limits: { max_files: 0, max_file_bytes: 0, capture_strategy: 'unknown' },
    baseline: {
      git_commit_hash: null,
      git_binding: 'none',
      dirty: false,
      untracked: [],
    },
    environment: defaultCoverageEnvironment(),
    captured_at,
    note,
  });
}

/** Validate a manifest, including its self-describing digest. */
export function validateCoverageManifest(value: unknown): string[] {
  const parsed = CoverageManifestSchema.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => issue.path.join('.') || '$');
  const manifest = parsed.data as CoverageManifestV1;
  const { coverage_digest: digest, ...body } = manifest;
  if (coverageManifestDigest(body) !== digest) return ['coverage_digest'];
  return [];
}

/**
 * True only for an explicit whole-repository claim: complete scope, no
 * exclusions, and a non-dirty baseline. Everything else stays visibly scoped.
 */
export function coverageIsWholeWorkspace(manifest: CoverageManifestV1): boolean {
  return (
    manifest.completeness === 'complete' &&
    manifest.scope.kind === 'repository' &&
    manifest.exclusions.length === 0 &&
    manifest.baseline.dirty === false
  );
}

/** Non-authoritative warnings that explain why coverage is not whole-workspace. */
export function coverageWarnings(manifest: CoverageManifestV1): string[] {
  const warnings: string[] = [];
  if (manifest.completeness === 'partial') warnings.push('coverage_partial');
  if (manifest.completeness === 'unknown') warnings.push('coverage_unknown');
  if (manifest.baseline.dirty) warnings.push('dirty_baseline');
  if (
    manifest.scope.kind === 'repository' &&
    manifest.baseline.untracked.length > 0
  )
    warnings.push('untracked_baseline');
  for (const exclusion of manifest.exclusions)
    warnings.push(`excluded:${exclusion.reason}:${exclusion.path}`);
  return [...new Set(warnings)].sort();
}

/** Whether a manifest's declared scope explicitly covers `path`. */
export function coverageCoversPath(
  manifest: CoverageManifestV1,
  path: string,
): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (manifest.exclusions.some((exclusion) => exclusion.path === normalized))
    return false;
  if (manifest.scope.kind === 'repository')
    return manifest.completeness !== 'unknown';
  if (manifest.scope.kind === 'files')
    return manifest.scope.paths.includes(normalized);
  return false;
}

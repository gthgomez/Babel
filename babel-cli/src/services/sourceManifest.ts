import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

export type SourceManifestFileKind = 'tracked' | 'untracked' | 'supplement';

export interface SourceManifestFileInput {
  path: string;
  kind?: SourceManifestFileKind;
}

export interface SourceManifestFile {
  path: string;
  kind: SourceManifestFileKind | 'symlink';
  sha256: string;
  bytes: number;
  mode: number;
  mtime_ms: number;
  line_ending: 'lf' | 'crlf' | 'mixed' | 'none';
  symlink_target?: string;
}

export interface ByteAttestedSourceManifest {
  schema_version: 'source-manifest.v1';
  root: string;
  files: SourceManifestFile[];
  manifest_sha256: string;
}

const PRIVATE_PATH_RE = /(?:^|[/\\])(?:\.env(?:\..*)?|\.codex|credentials?|auth(?:entication)?|secrets?|raw[-_ ]?transcripts?|cache|caches|runs?|artifacts?)(?:[/\\]|$)/i;
const PRIVATE_BASENAME_RE = /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\..*)?|.*\.pem|.*\.key)$/i;

function normalizeRelativePath(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`source manifest path escapes root: ${candidate}`);
  }
  const normalized = rel.split(sep).join('/');
  if (PRIVATE_PATH_RE.test(normalized) || PRIVATE_BASENAME_RE.test(basename(normalized))) {
    throw new Error(`source manifest refuses private path: ${normalized}`);
  }
  return normalized;
}

function lineEnding(bytes: Buffer): SourceManifestFile['line_ending'] {
  const text = bytes.toString('utf8');
  const hasLf = /\n/.test(text);
  const hasCrLf = /\r\n/.test(text);
  const hasBareLf = /(^|[^\r])\n/.test(text);
  if (!hasLf && !hasCrLf) return 'none';
  if (hasCrLf && hasBareLf) return 'mixed';
  return hasCrLf ? 'crlf' : 'lf';
}

function hashManifestFiles(files: SourceManifestFile[]): string {
  const canonical = JSON.stringify(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        kind: file.kind,
        sha256: file.sha256,
        bytes: file.bytes,
        line_ending: file.line_ending,
        ...(file.symlink_target !== undefined ? { symlink_target: file.symlink_target } : {}),
      })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function portableFileIdentity(file: SourceManifestFile): Record<string, unknown> {
  return {
    path: file.path,
    kind: file.kind,
    sha256: file.sha256,
    bytes: file.bytes,
    line_ending: file.line_ending,
    ...(file.symlink_target !== undefined ? { symlink_target: file.symlink_target } : {}),
  };
}

function assertResolvedContainment(root: string, absolute: string, normalized: string): void {
  const resolvedRoot = realpathSync(root);
  const resolvedCandidate = realpathSync(absolute);
  const resolvedRelative = relative(resolvedRoot, resolvedCandidate);
  if (
    !resolvedRelative ||
    resolvedRelative === '..' ||
    resolvedRelative.startsWith(`..${sep}`) ||
    /^[A-Za-z]:/.test(resolvedRelative)
  ) {
    throw new Error(`source manifest path resolves outside root: ${normalized}`);
  }
}

/**
 * Build a byte-attested manifest for an explicitly enumerated source set.
 * The function never follows symlinks and rejects credential/private paths.
 */
export function buildByteAttestedSourceManifest(input: {
  root: string;
  files: SourceManifestFileInput[];
}): ByteAttestedSourceManifest {
  const root = realpathSync(resolve(input.root));
  const files: SourceManifestFile[] = [];
  const seen = new Set<string>();

  for (const item of input.files) {
    const normalized = normalizeRelativePath(root, item.path);
    if (seen.has(normalized)) throw new Error(`duplicate source manifest path: ${normalized}`);
    seen.add(normalized);
    const absolute = resolve(root, normalized);
    assertResolvedContainment(root, absolute, normalized);
    const metadata = lstatSync(absolute);
    if (metadata.isDirectory()) throw new Error(`source manifest path is a directory: ${normalized}`);

    if (metadata.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      const targetBytes = Buffer.from(target, 'utf8');
      files.push({
        path: normalized,
        kind: 'symlink',
        sha256: createHash('sha256').update(targetBytes).digest('hex'),
        bytes: targetBytes.byteLength,
        mode: metadata.mode,
        mtime_ms: metadata.mtimeMs,
        line_ending: 'none',
        symlink_target: target,
      });
      continue;
    }

    if (!metadata.isFile()) throw new Error(`source manifest path is not a regular file: ${normalized}`);
    const bytes = readFileSync(absolute);
    files.push({
      path: normalized,
      kind: item.kind ?? 'tracked',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      mode: metadata.mode,
      mtime_ms: metadata.mtimeMs,
      line_ending: lineEnding(bytes),
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema_version: 'source-manifest.v1',
    root,
    files,
    manifest_sha256: hashManifestFiles(files),
  };
}

export interface SourceManifestVerificationResult {
  ok: boolean;
  /** Portable content-identity mismatches by relative path. */
  mismatches: string[];
  /** Metadata-only drift by relative path; does not invalidate content identity. */
  metadata_mismatches: string[];
  /** Manifest-level integrity or inventory-shape failures. */
  manifest_mismatches: string[];
}

/**
 * Verify an explicitly enumerated manifest against its declared root.
 * This validates the unsigned manifest's internal consistency; it does not
 * discover or authenticate repository-wide tracked/untracked inventory.
 */
export function verifyByteAttestedSourceManifest(
  manifest: ByteAttestedSourceManifest,
): SourceManifestVerificationResult {
  const mismatches: string[] = [];
  const metadata_mismatches: string[] = [];
  const manifest_mismatches: string[] = [];
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) manifest_mismatches.push(`duplicate:${file.path}`);
    seen.add(file.path);
  }
  if (manifest.files.length === 0) manifest_mismatches.push('inventory');
  if (manifest.manifest_sha256 !== hashManifestFiles(manifest.files)) {
    manifest_mismatches.push('manifest_sha256');
  }

  let root: string;
  try {
    root = realpathSync(resolve(manifest.root));
  } catch {
    manifest_mismatches.push('root');
    return {
      ok: false,
      mismatches,
      metadata_mismatches,
      manifest_mismatches,
    };
  }

  for (const file of manifest.files) {
    try {
      const input: SourceManifestFileInput = { path: file.path };
      if (file.kind !== 'symlink') input.kind = file.kind;
      const current = buildByteAttestedSourceManifest({ root, files: [input] }).files[0];
      if (!current || JSON.stringify(portableFileIdentity(current)) !== JSON.stringify(portableFileIdentity(file))) {
        mismatches.push(file.path);
      }
      if (
        current &&
        (current.mode !== file.mode || current.mtime_ms !== file.mtime_ms) &&
        !metadata_mismatches.includes(file.path)
      ) {
        metadata_mismatches.push(file.path);
      }
    } catch {
      mismatches.push(file.path);
    }
  }
  return {
    ok: mismatches.length === 0 && manifest_mismatches.length === 0,
    mismatches,
    metadata_mismatches,
    manifest_mismatches,
  };
}

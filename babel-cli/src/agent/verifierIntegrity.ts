/**
 * R9 verifier integrity — content hashing for dependency-tamper detection.
 *
 * package.json is special: only the `scripts` section is integrity-relevant.
 * Legitimate dependency / metadata edits (PAR-A03 class) must not set
 * verifier_tampered. Script rewrites and verifier script file edits still do.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Normalize a relative path for integrity key matching (posix-style).
 */
export function normalizeIntegrityPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * True when the path is a package.json (repo-root or nested).
 */
export function isPackageJsonPath(relativePath: string): boolean {
  const norm = normalizeIntegrityPath(relativePath);
  return norm === 'package.json' || norm.endsWith('/package.json');
}

/**
 * Hash content of a verifier-tracked file for integrity checks.
 *
 * - package.json → stable hash of the `scripts` object only
 * - all other files → full content SHA-256
 * - invalid package.json JSON → raw content hash (corruption still flags)
 */
export function hashVerifierTrackedContent(relativePath: string, content: Buffer | string): string {
  if (isPackageJsonPath(relativePath)) {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    try {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      const scripts = pkg['scripts'];
      const normalizedScripts =
        scripts && typeof scripts === 'object' && !Array.isArray(scripts)
          ? Object.fromEntries(
              Object.entries(scripts as Record<string, unknown>).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            )
          : {};
      return createHash('sha256').update(JSON.stringify(normalizedScripts)).digest('hex');
    } catch {
      return createHash('sha256')
        .update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
        .digest('hex');
    }
  }
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compare pre/post integrity hash maps. True when any pre-tracked file changed.
 * Missing post entry for a pre-tracked file counts as tamper (file deleted).
 * Empty post + non-empty pre = total wipe of tracked deps → tamper.
 */
export function hasVerifierDependencyTamper(
  preRunHashes: Record<string, string>,
  postRunHashes: Record<string, string>,
): boolean {
  const preKeys = Object.keys(preRunHashes);
  if (preKeys.length === 0) return false;
  // All pre-tracked files gone (empty post) is total deletion → tamper.
  if (Object.keys(postRunHashes).length === 0) return true;
  // Missing key or hash mismatch on any pre-tracked path is tamper.
  return preKeys.some((file) => preRunHashes[file] !== postRunHashes[file]);
}

/**
 * Discover and hash verifier dependency files under projectRoot.
 *
 * Files tracked:
 *   - package.json (scripts slice — always when present)
 *   - Script files referenced by `npm run <script>` (resolved from package.json)
 *   - Files referenced directly in commands (e.g. `node verify.mjs`)
 *   - Other .mjs/.js/.sh files appearing in command strings
 */
export function computeVerifierDependencyHashes(
  projectRoot: string,
  allowedVerifierCommands: string[],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  const filesToHash = new Set<string>();
  let packageJson: Record<string, unknown> | null = null;

  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      packageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      // Not valid JSON — skip script resolution; still hash raw below
    }
  }

  for (const command of allowedVerifierCommands) {
    const npmRunMatch = command.match(/^npm\s+(?:run\s+)?(\S+)/);
    if (npmRunMatch && packageJson) {
      filesToHash.add('package.json');
      const scriptName = npmRunMatch[1]!;
      const scripts = packageJson['scripts'] as Record<string, string> | undefined;
      const scriptCmd = scripts?.[scriptName];
      if (scriptCmd) {
        const scriptFileRefs = scriptCmd.match(/([^\s"'`]+\.(?:mjs|js|cjs|ts))\b/g);
        if (scriptFileRefs) {
          for (const f of scriptFileRefs) {
            filesToHash.add(f);
          }
        }
      }
      continue;
    }

    const nodeFileMatch = command.match(/^node\s+(?!(?:-e|--test|--check)\b)(\S+)/);
    if (nodeFileMatch && nodeFileMatch[1]) {
      filesToHash.add(nodeFileMatch[1]);
      continue;
    }

    const fileRefs = command.match(/([^\s"'`]+\.(?:mjs|js|sh|bat|cmd))\b/g);
    if (fileRefs) {
      for (const f of fileRefs) {
        if (!f.startsWith('-')) filesToHash.add(f);
      }
    }
  }

  // Always track package.json as a baseline tamper target (scripts slice only)
  filesToHash.add('package.json');

  for (const file of filesToHash) {
    const absPath = join(projectRoot, file);
    if (existsSync(absPath)) {
      const content = readFileSync(absPath);
      hashes[file] = hashVerifierTrackedContent(file, content);
    }
  }

  return hashes;
}

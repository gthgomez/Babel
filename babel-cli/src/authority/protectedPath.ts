// ─── Credential-path protection (P0-C) ───────────────────────────────────────

/**
 * Normalize a path for credential matching (posix-style, lowercase).
 */
function normalizePathForCredentialMatch(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * True when a path is a live credential store per rule 09. Synthetic-test
 * friendly: pure path inspection, never reads contents.
 *
 * Covers: .env / .env.* (excluding .env.example), private keys, certificate
 * stores, cloud credential stores, SSH keys, credential configs, secrets dirs.
 */
export function isCredentialTargetPath(path: string): boolean {
  const norm = normalizePathForCredentialMatch(path);
  const segments = norm.split('/');
  const basename = segments[segments.length - 1] ?? '';

  if (/^\.env(?:\.[a-z0-9_-]+)?$/.test(basename) && !basename.startsWith('.env.example')) {
    return true;
  }
  if (/^(id_rsa|id_ed25519|id_dsa|id_ecdsa)$/.test(basename)) return true;
  if (/\.(pem|p12|pfx|key)$/.test(basename)) return true;
  if (basename === 'credentials.json' || basename === '.git-credentials' || basename === '.npmrc') {
    return true;
  }
  if (segments.includes('.ssh')) return true;
  if (segments.includes('secrets')) return true;
  if (segments.includes('.aws') && basename === 'credentials') return true;
  return false;
}

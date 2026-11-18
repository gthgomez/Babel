// ─── Credential-path protection (P0-C) ───────────────────────────────────────

/**
 * Normalize a path for credential matching (posix-style, lowercase).
 *
 * This is pure path inspection: it never opens or reads the candidate. It is
 * the single registry used by file effects, shell argv filtering, Git
 * inspection, receipts, fixtures and workspace tools.
 */
function normalizePathForCredentialMatch(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

const CREDENTIAL_BASENAMES = new Set([
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.envrc',
  'credentials.json',
  'credentials',
  'auth.json',
  'cookies.json',
]);

const CREDENTIAL_DIRECTORIES = new Set(['.ssh', '.gnupg', '.password-store', '.aws', 'secrets']);

/** Exact documentation templates remain readable; everything else `.env*` is live. */
function isDotenvCredential(basename: string): boolean {
  if (!basename.startsWith('.env')) return false;
  // Documentation templates and their variants are readable by convention.
  if (basename.startsWith('.env.example') || basename.startsWith('.env.sample') || basename.startsWith('.env.template')) {
    return false;
  }
  return /^\.env(?:\.[a-z0-9_-]+)*$/.test(basename);
}

function isCredentialBasename(basename: string): boolean {
  if (isDotenvCredential(basename)) return true;
  if (CREDENTIAL_BASENAMES.has(basename)) return true;
  if (/^\.envrc(?:\.|$)/.test(basename)) return true;
  if (/^(id_rsa|id_ed25519|id_dsa|id_ecdsa)$/.test(basename)) return true;
  if (/\.(pem|p12|pfx|key|jks|keystore)$/.test(basename)) return true;
  if (/^\.?(?:docker|kube)config(?:\.json|\.yaml)?$/.test(basename)) return true;
  return false;
}

/**
 * True when a path names a live credential store.
 *
 * Covers: dotenv files (excluding documentation templates), private keys and
 * certificate stores, cloud/registry credential stores, SSH/GPG agent stores,
 * and `secrets` directories. Synthetic-test friendly: pure path inspection,
 * never reads contents.
 */
export function isCredentialTargetPath(path: string): boolean {
  if (!path) return false;
  const norm = normalizePathForCredentialMatch(path).replace(/\/+$/, '');
  const segments = norm.split('/').filter((segment) => segment.length > 0);
  const basename = segments[segments.length - 1] ?? '';

  if (isCredentialBasename(basename)) return true;
  if (segments.some((segment) => CREDENTIAL_DIRECTORIES.has(segment))) return true;
  if (segments.includes('.aws') && (basename === 'credentials' || basename === 'config')) return true;
  if (segments.includes('.docker') && basename === 'config.json') return true;
  if (segments.includes('.kube') && basename === 'config') return true;
  if (segments.includes('.config') && segments.includes('gh') && (basename === 'hosts.yml' || basename === 'config.yml')) {
    return true;
  }
  return false;
}

/** Strip one optional environment-assignment prefix (`NAME=value`). */
function stripAssignment(token: string): string {
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(token);
  return assignment ? (assignment[1] ?? '') : token;
}

/** Strip revision prefixes Git uses before a path (`HEAD:.env`, `origin/main:.env`). */
function revisionSuffixes(token: string): string[] {
  const withoutAssignment = stripAssignment(token);
  const candidates = [withoutAssignment];
  const revisionMatch = /^[^:\\/]+:(.+)$/.exec(withoutAssignment);
  if (revisionMatch?.[1]) candidates.push(revisionMatch[1]);
  return candidates;
}

function trimArgumentPunctuation(token: string): string {
  return token.replace(/^[("'`<\s]+/, '').replace(/[)"'`>,\s]+$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Raw-text fallback built from the same vocabulary, for paths embedded inside
 * quoted interpreter code (`python -c "...open('.env')..."`). Kept in this
 * module so the token and substring checks cannot drift apart.
 */
const CREDENTIAL_RAW_PATH_RE = new RegExp(
  [
    `(?:^|[\\s"'\`\\/:(=,])${'(?:'}` +
      `\\.env(?!(?:\\.(?:example|sample|template))(?:[./\\\\]|$))(?:\\.[a-z0-9_-]+)*` +
      `|\\.envrc(?:\\.[a-z0-9_-]+)*` +
      `|(?:${[...CREDENTIAL_BASENAMES].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})` +
      `|(?:id_rsa|id_ed25519|id_dsa|id_ecdsa)` +
      `|(?:[a-z0-9_.-]+\\.(?:pem|p12|pfx|key|jks|keystore))` +
      ')(?=$|[\\s"\'`\\/:),;])',
    `|(?:^|[\\s"'\`\\/:(])${[...CREDENTIAL_DIRECTORIES].map(escapeRegExp).join('|')}(?:[\\/]|$)` +
      '|(?:^|[\\s"\'`\\/:(])\\.config[\\/]gh[\\/]',
  ].join(''),
  'i',
);

/**
 * True when a command line mentions a credential-class path.
 *
 * Conservative: tokens are split on whitespace so Windows drive paths keep
 * their shape, with a fallback for paths quoted inside interpreter code. This
 * is intentionally a *path* classifier, not a command allowlist: callers keep
 * their own execution policy, and this only identifies the credential effect.
 */
export function isCredentialPathReference(command: string): boolean {
  if (!command) return false;
  for (const rawToken of command.split(/\s+/)) {
    const token = trimArgumentPunctuation(rawToken);
    if (!token || token.startsWith('-')) continue;
    for (const candidate of revisionSuffixes(token)) {
      if (isCredentialTargetPath(trimArgumentPunctuation(candidate))) return true;
    }
  }
  return CREDENTIAL_RAW_PATH_RE.test(command);
}

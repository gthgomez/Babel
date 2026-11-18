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

/**
 * `.env` and every `.env.*` suffix are live credential material, including
 * non-alphanumeric tails such as `.env.local~` and a bare `.env.`. Only the
 * three canonical value-free templates are readable.
 */
function isDotenvCredential(basename: string): boolean {
  if (basename === '.env.example' || basename === '.env.sample' || basename === '.env.template') {
    return false;
  }
  return basename === '.env' || basename.startsWith('.env.');
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
 * Covers: `.env` plus every `.env.*` suffix except `.env.example`,
 * `.env.sample` and `.env.template`; private keys and certificate stores;
 * cloud/registry credential stores; SSH/GPG agent stores; and `secrets`
 * directories. Synthetic-test friendly: pure path inspection,
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

/**
 * Strip revision prefixes Git uses before a path:
 * `HEAD:.env`, `origin/main:.env`, index `:.env`, and staged `:0:.env`.
 */
function revisionSuffixes(token: string): string[] {
  const withoutAssignment = stripAssignment(token);
  const candidates = [withoutAssignment];
  if (withoutAssignment.startsWith(':')) {
    const stagedIndex = /^:(?:\d+)?:(.+)$/.exec(withoutAssignment);
    candidates.push(stagedIndex?.[1] ?? withoutAssignment.slice(1));
  }
  const revisionMatch = /^[^:\\/]+:(.+)$/.exec(withoutAssignment);
  if (revisionMatch?.[1]) candidates.push(revisionMatch[1]);
  return candidates;
}

function trimArgumentPunctuation(token: string): string {
  return token.replace(/^[("'`<@\s]+/, '').replace(/[)"'`>,\s]+$/, '');
}

/**
 * Raw-text fallback, for paths embedded inside quoted interpreter code
 * (`python -c "...open('.env')..."`). Candidates are split on quoting and
 * expression punctuation, then classified by the same path registry above, so
 * no second vocabulary is introduced. Linear scan; no nested repetition.
 */
const RAW_CANDIDATE_RE = /[^\s"'`()=,;]+/g;

function rawCandidateMentionsCredential(command: string): boolean {
  for (const match of command.matchAll(RAW_CANDIDATE_RE)) {
    const candidate = trimArgumentPunctuation(match[0] ?? '');
    if (!candidate) continue;
    for (const revision of revisionSuffixes(candidate)) {
      if (isCredentialTargetPath(trimArgumentPunctuation(revision))) return true;
    }
  }
  return false;
}

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
  return rawCandidateMentionsCredential(command);
}

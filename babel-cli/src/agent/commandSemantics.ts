/**
 * commandSemantics.ts — deterministic, command-text semantic classification (P0-D).
 *
 * `classifyToolEffect()` (executor/contracts.ts) classifies by tool NAME only, so
 * `shell_exec("npm test")` and `shell_exec("git push --force")` both resolve to the
 * same `non_idempotent_local_effect` class. This module adds the missing
 * command-semantic layer: it normalizes a shell command string as far as it is
 * deterministically safe to do, and classifies it into a small semantic taxonomy
 * that the autonomy policy (config/autonomyPolicy.ts) maps onto the existing A–D
 * authority classes. `ToolEffectClass` is NOT replaced.
 *
 * Design constraints (per cross-review P0-D / §7):
 *  - Pure module: no imports from the V9 lane (pipeline/schemas) — zero co-evolution debt.
 *  - Conservative: ambiguous commands classify as 'unrecognized' (NOT forbidden).
 *  - Wrapper/alias normalization is best-effort. Evasion beyond it lands in
 *    'unrecognized' or the sandbox's own path/command jail (defense in depth).
 *  - This is NOT general program analysis. It detects clear, high-confidence
 *    external/public/destructive effects and nothing more.
 *  - "Unknown does not automatically mean forbidden" — only clearly
 *    external/public effects are escalated, via the decision mapping.
 */

// ─── Taxonomy ────────────────────────────────────────────────────────────────

export type CommandSemanticClass =
  | 'read_local'
  | 'test_local'
  | 'write_local_reversible'
  | 'delete_local'
  | 'delete_destructive'
  | 'install_dependency'
  | 'network_read'
  | 'credential_access'
  | 'git_commit'
  | 'git_push'
  | 'git_history_rewrite'
  | 'create_pr'
  | 'external_message'
  | 'deploy'
  | 'infrastructure_mutation'
  | 'financial_external_effect'
  | 'unrecognized';

/** Most-severe-first ordering for chained commands (`a && b; c`). */
export const SEMANTIC_SEVERITY: readonly CommandSemanticClass[] = [
  'credential_access',
  'financial_external_effect',
  'deploy',
  'infrastructure_mutation',
  'external_message',
  'git_history_rewrite',
  'delete_destructive',
  'create_pr',
  'git_push',
  'install_dependency',
  'delete_local',
  'git_commit',
  'write_local_reversible',
  'network_read',
  'test_local',
  'read_local',
  'unrecognized',
] as const;

const SEVERITY_INDEX = new Map<CommandSemanticClass, number>(
  SEMANTIC_SEVERITY.map((cls, i) => [cls, i]),
);

function moreSevere(a: CommandSemanticClass, b: CommandSemanticClass): CommandSemanticClass {
  const ia = SEVERITY_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER;
  const ib = SEVERITY_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER;
  return ia <= ib ? a : b;
}

// ─── Normalization ───────────────────────────────────────────────────────────

const WRAPPER_PREFIXES: ReadonlyArray<{ re: RegExp; extract: (m: RegExpMatchArray) => string }> = [
  {
    // sudo [flags] <cmd>
    re: /^\s*sudo\s+(?:-[A-Za-z]+\s+)*/i,
    extract: (m) => m[0]!,
  },
  {
    // env [-i] [VAR=...] <cmd> — common credential-dump / push wrapper.
    re: /^\s*env\s+(?:-[A-Za-z]+\s+)*(?:[A-Z_][A-Z0-9_]*=(".*?"|'.*?'|\S+)\s+)*/i,
    extract: (m) => m[0]!,
  },
  {
    // nohup / timeout / nice / taskset — pure command prefixes.
    re: /^\s*(?:nohup|timeout|nice|taskset)(?:\s+-[A-Za-z0-9]+\s*)*\s+/i,
    extract: (m) => m[0]!,
  },
  {
    // bash|sh|zsh [-flags] -c <quoted command>
    re: /^\s*(?:bash|sh|zsh|dash)(?:\.exe)?\s+(?:-[A-Za-z0-9]+\s+)*-c\s+/i,
    extract: (m) => m[0]!,
  },
  {
    // powershell|pwsh [-flags] -Command <quoted command>
    re: /^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:-[A-Za-z0-9]+\s+)*-?Command\s+/i,
    extract: (m) => m[0]!,
  },
  {
    // cmd /c <command>
    re: /^\s*(?:cmd|cmd\.exe)\s+\/c\s+/i,
    extract: (m) => m[0]!,
  },
];

/**
 * Best-effort unwrapping of common wrapper prefixes. Applied up to 3 passes.
 * Returns the innermost command text, with one layer of surrounding quotes removed.
 */
export function unwrapCommandWrappers(raw: string): string {
  let current = raw.trim();
  for (let pass = 0; pass < 3; pass++) {
    let unwrapped = false;
    for (const wrapper of WRAPPER_PREFIXES) {
      const m = current.match(wrapper.re);
      if (m) {
        current = current.slice(m[0]!.length).trim();
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) break;
  }
  // Remove one layer of surrounding quotes (matching single or double).
  const first = current[0];
  if (first === '"' || first === "'") {
    const last = current[current.length - 1];
    if (last === first) {
      current = current.slice(1, -1).trim();
    }
  }
  return current;
}

/** Split a command on chain operators; the most severe segment decides. */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface CommandParts {
  /** Executable base name (lowercase, .exe and path stripped), or '' when unparseable. */
  base: string;
  /** Everything after the executable. */
  rest: string;
}

/**
 * Extract executable base + remaining args from one command segment.
 *
 * Splits on the first whitespace, then strips any path prefix and `.exe` from
 * the first token. Handles `git push`, `C:\tools\git.exe push`, `/usr/bin/git
 * rebase`, `git.exe push -f`. Quoted executables containing spaces are not
 * un-wrapped (documented limitation; the sandbox path jail is the backstop).
 */
export function splitCommandParts(segment: string): CommandParts {
  const trimmed = segment.trim();
  const spaceIdx = trimmed.search(/\s/);
  const firstToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  const token = firstToken.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return { base: token.toLowerCase(), rest };
}

// ─── Credential detection ────────────────────────────────────────────────────

const CREDENTIAL_PATH_RE =
  /(?:^|[\s"'`\\/])\.env(?![A-Za-z0-9._-]*\.example\b)(?:\.[A-Za-z0-9_-]+)?\b(?:\s|$|['"`\\/])|(?:^|[\s"'`\\/])(?:id_rsa|id_ed25519|id_dsa|credentials\.json|\.pem|\.p12|\.pfx)(?:\s|$|['"`\\/])|\.ssh[\\/]|\.aws[\\/]credentials|\.git-credentials|secrets[\\/]/i;
const CREDENTIAL_DUMP_TOOLS =
  /^\s*(?:cat|type|get-content|more|less|head|tail|bat|printf)\s+/i;
const CREDENTIAL_VAR_ECHO = /(?:echo|printenv|env|set)\s+[^\s]*(?:API[_]?KEY|TOKEN|SECRET|PASSWORD)/i;
const PICKAXE_LOG = /\bgit\s+log\s+--all\s+--pickaxe\b/i;
/** Credential transfer: local copies and exfiltration carriers. */
const CREDENTIAL_TRANSFER_TOOLS =
  /^\s*(?:cp|mv|scp|rsync|copy-item|aws\s+s3\s+cp|gsutil\s+cp|az\s+storage\s+blob\s+copy)\s+/i;
/** Inline code interpreters that can read files (`python -c "open('.env')"`). */
const CREDENTIAL_CODE_EVAL =
  /^\s*(?:python|python3|node|tsx|deno|ruby|perl)\s+(?:-[a-z]+\s+)*(?:-c|-e|--eval)\s+/i;

/** True when a normalized command is a clear credential read/exposure attempt. */
export function isCredentialExposureCommand(command: string): boolean {
  if (PICKAXE_LOG.test(command)) return true;
  if (CREDENTIAL_VAR_ECHO.test(command)) return true;
  if (CREDENTIAL_DUMP_TOOLS.test(command) && CREDENTIAL_PATH_RE.test(command)) return true;
  if (CREDENTIAL_TRANSFER_TOOLS.test(command) && CREDENTIAL_PATH_RE.test(command)) return true;
  if (CREDENTIAL_CODE_EVAL.test(command) && CREDENTIAL_PATH_RE.test(command)) return true;
  return false;
}

// ─── Base-command dispatch ───────────────────────────────────────────────────

function classifyGit(base: string, rest: string): CommandSemanticClass {
  // History-rewriting / destructive forms are checked BEFORE plain commit/push
  // so `git commit --amend` and `git push --force-with-lease` are gated.
  // Case-insensitive: git subcommands are case-insensitive in practice.
  if (
    /\b(rebase|reset\s+--hard|clean\s+-(?:fd|df)|commit\s+--amend|branch\s+-(?:d|D)|push\s+--force-with-lease)\b/i.test(
      rest,
    )
  ) {
    return 'git_history_rewrite';
  }
  if (/\bpush\b/i.test(rest)) return 'git_push';
  if (/\bcommit\b/i.test(rest)) return 'git_commit';
  return 'write_local_reversible';
}

/** Destructive DB operations (`drop table`, `truncate`, `delete from`). */
function classifyDatabase(base: string, rest: string): CommandSemanticClass | null {
  if (
    (base === 'drop' || base === 'truncate') &&
    /\b(table|database|schema)\b/i.test(rest)
  ) {
    return 'infrastructure_mutation';
  }
  if (base === 'delete' && /\bfrom\b/i.test(rest)) {
    return 'infrastructure_mutation';
  }
  return null;
}

/** True when a git push is gated per repo policy (rule 05: force/history/main). */
export function isGatedGitPush(command: string): boolean {
  const m = command.match(/\bgit\b[^&|;]*\bpush\b([^&|;]*)/i);
  if (!m) return false;
  const args = m[1] ?? '';
  return (
    /(?:--force|-f\b|--force-with-lease)/.test(args) ||
    /(?:--delete\b|origin\s+main|origin\/main|\bmain\b|\bmaster\b)/.test(args)
  );
}

function classifyDeployTools(base: string, rest: string): CommandSemanticClass | null {
  if (base === 'terraform' && /\b(apply|destroy)\b/i.test(rest)) return 'infrastructure_mutation';
  if (base === 'kubectl' && /\b(apply|delete|create|scale|rollout)\b/i.test(rest)) {
    return 'infrastructure_mutation';
  }
  if (base === 'docker' && /\brm\b/i.test(rest) && /-f\b/i.test(rest)) return 'delete_destructive';
  if (base === 'docker' && /\bpush\b/i.test(rest)) return 'deploy';
  if ((base === 'aws' || base === 'gcloud' || base === 'az') && /\b(iam|organizations?)\b/i.test(rest)) {
    return 'infrastructure_mutation';
  }
  if ((base === 'aws' || base === 'gcloud' || base === 'az') && /\bbilling\b/i.test(rest)) {
    return 'financial_external_effect';
  }
  return null;
}

function classifyMessaging(base: string, rest: string): CommandSemanticClass | null {
  if (/\b(msgsend|slack|discord|sendmail|mail|twilio|sendgrid)\b/i.test(`${base} ${rest}`)) {
    return 'external_message';
  }
  if (
    (base === 'curl' || base === 'wget') &&
    /\b(POST|PUT|PATCH|DELETE)\b/i.test(rest) &&
    /\b(webhook|slack|discord|telegram|zapier|make\.com)\b/i.test(rest)
  ) {
    return 'external_message';
  }
  return null;
}

const TEST_RUNNER_RE =
  /^(?:pytest|npx\s+jest|npx\s+vitest|npx\s+mocha|cargo\s+test|go\s+test|dotnet\s+test|node\s+--test|tsx\s+--test|npm\s+test|npm\s+run\s+test)/i;

/**
 * Classify one normalized command segment into the semantic taxonomy.
 * 'unrecognized' is the conservative default — it is NOT a denial class.
 */
export function classifyCommandSegment(segment: string): CommandSemanticClass {
  const normalized = unwrapCommandWrappers(segment);

  // Credential exposure is checked against the full segment first (tool-agnostic).
  if (isCredentialExposureCommand(normalized)) return 'credential_access';

  const { base, rest } = splitCommandParts(normalized);
  if (!base) return 'unrecognized';

  // Network clients: default network_read; messaging detection above can escalate.
  if (base === 'curl' || base === 'wget') {
    const messaging = classifyMessaging(base, rest);
    return messaging ?? 'network_read';
  }

  const messaging = classifyMessaging(base, rest);
  if (messaging) return messaging;

  if (base === 'git') return classifyGit(base, rest);
  if (base === 'gh') {
    if (/\bpr\s+create\b/.test(rest)) return 'create_pr';
    if (/\brelease\s+create\b/.test(rest)) return 'deploy';
    return 'write_local_reversible';
  }

  const deployClass = classifyDeployTools(base, rest);
  if (deployClass) return deployClass;

  const dbClass = classifyDatabase(base, rest);
  if (dbClass) return dbClass;

  if (base === 'npm' || base === 'pnpm' || base === 'yarn') {
    if (/\bpublish\b/i.test(rest)) return 'deploy';
    if (/\b(install|add|ci|dlx)\b/i.test(rest)) return 'install_dependency';
    if (TEST_RUNNER_RE.test(normalized)) return 'test_local';
    return 'write_local_reversible';
  }
  if (base === 'pip' || base === 'pip3' || base === 'poetry' || base === 'uv') {
    if (/\b(install|add)\b/i.test(rest)) return 'install_dependency';
  }
  if (base === 'go' && /\b(install|get)\b/i.test(rest)) return 'install_dependency';
  if (base === 'cargo' && /\b(install|add)\b/i.test(rest)) return 'install_dependency';

  if (base === 'rm' || base === 'rmdir') {
    // Combined short flags (-rf, -fr, -rfv) or long forms count as destructive;
    // `rm -r` / `rm -f` alone stay bounded local deletes.
    return /-[a-zA-Z]*[rf][a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force|\/s\b/i.test(rest)
      ? 'delete_destructive'
      : 'delete_local';
  }
  if (base === 'remove-item' || base === 'del' || base === 'erase') {
    return /-recurse|-r\b|-f\b|-force|\/s\b|\/q\b/i.test(rest)
      ? 'delete_destructive'
      : 'delete_local';
  }

  if (TEST_RUNNER_RE.test(normalized)) return 'test_local';

  return 'unrecognized';
}

/**
 * Classify a full command string (possibly chained) into the most severe
 * semantic class of any segment. Chaining is conservative: `test -f x && cat .env`
 * is classified by the credential segment.
 */
export function classifyCommandSemantics(command: string): CommandSemanticClass {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return 'unrecognized';
  return segments.map(classifyCommandSegment).reduce(moreSevere);
}

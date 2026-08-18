/**
 * commandDecoder.ts — one conservative quote/escape-aware command decoder (P0-2).
 *
 * Convergence of PR #86 gitCommand.ts and PR #87 commandSemantics.ts into a
 * single parse authority. This is NOT a shell interpreter: it tokenizes argv
 * with quoting/escaping awareness, splits chains on UNQUOTED `&&` `||` `;`,
 * and decodes each segment into a structured capability (PDP-facing) plus a
 * semantic class (autonomy-facing). Two consumers — the PDP (via
 * gitCommand.ts) and the autonomy layer (via commandSemantics.ts) — share
 * this one decoder; no second parser exists.
 *
 * Posture (cross-review P0-2 / second-layer review):
 *  - Recognized safe/reversible semantics map to local capabilities.
 *  - Unrecognized semantics stay `unrecognized` — the PDP and lease allowlist
 *    are the authority, never inferred from the parser.
 *  - Fail-closed surfaces (credential, privileged git/gh, dangerous tools)
 *    decode to gated/forbidden capabilities.
 */

import type { CapabilityId } from './capabilities.js';

// ─── Taxonomy (single source; commandSemantics.ts re-exports) ───────────────

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

export interface DecodedCommand {
  /** PDP-facing capability (may be 'unknown'). */
  capability: CapabilityId | 'unknown';
  /** Autonomy-facing semantic class. */
  semantic: CommandSemanticClass;
  remote?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  force: boolean;
  delete: boolean;
  /** Concrete PR number or other target identity. */
  target?: string;
  /** Deploy/target environment when the command names one. */
  environment?: string;
  /** Set when the raw command was unparseable but privileged-looking. */
  ambiguous?: boolean;
}

// ─── Lexer ──────────────────────────────────────────────────────────────────

/**
 * Quote/escape-aware argv tokenization. Single and double quotes group;
 * backslashes are treated LITERALLY (Windows paths like `C:\tools\git.exe`
 * must survive intact — escaped separators are handled by splitChains, not
 * here). Conservative: it does NOT resolve env expansion, aliases, or shell
 * constructs.
 */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  const n = command.length;
  const push = () => {
    if (cur !== '') {
      out.push(cur);
      cur = '';
    }
  };
  for (let i = 0; i < n; i++) {
    const ch = command[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      else cur += ch;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      cur += ch;
    }
  }
  push();
  return out;
}

/**
 * Split a command on chain operators, respecting quoting and backslash
 * escapes. `a && b` / `a || b` / `a ; b` — a separator inside quotes or
 * escaped is part of the argument.
 */
export function splitChains(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  const n = command.length;
  const push = () => {
    const trimmed = cur.trim();
    if (trimmed !== '') out.push(trimmed);
    cur = '';
  };
  for (let i = 0; i < n; i++) {
    const ch = command[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      cur += ch;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      cur += ch;
    } else if (ch === "'") {
      inSingle = true;
      cur += ch;
    } else if (ch === '"') {
      inDouble = true;
      cur += ch;
    } else if (ch === '\\' && i + 1 < n) {
      cur += ch + command[i + 1]!;
      i += 1;
    } else if (ch === ';') {
      push();
    } else if (ch === '&' && command[i + 1] === '&') {
      push();
      i += 1;
    } else if (ch === '|' && command[i + 1] === '|') {
      push();
      i += 1;
    } else {
      cur += ch;
    }
  }
  push();
  return out;
}

// ─── Wrapper normalization ──────────────────────────────────────────────────

/** Wrapper prefixes whose flags do NOT consume a following argument. */
const WRAPPER_FLAG_ONLY: ReadonlyArray<{ re: RegExp; flags: ReadonlySet<string> }> = [
  { re: /^sudo$/i, flags: new Set(['-e', '-i', '-n', '-s', '-h', '-v', '-k']) },
  { re: /^env$/i, flags: new Set(['-i', '-u', '-0', '-n']) },
  { re: /^(nohup|nice|taskset)$/i, flags: new Set(['-n', '-p']) },
];

/**
 * Best-effort unwrapping of common wrapper prefixes (up to 3 passes).
 * Option arguments are consumed (`sudo -u alice`, `env -i VAR=x`), so the
 * real executable is what remains. One layer of surrounding quotes is
 * removed. PowerShell invocation blocks (`& { ... }`) are unwrapped.
 */
export function unwrapCommandWrappers(raw: string): string {
  let current = raw.trim();
  for (let pass = 0; pass < 3; pass++) {
    const tokens = tokenize(current);
    if (tokens.length === 0) break;
    const base = tokens[0]!.toLowerCase().replace(/\.exe$/i, '');
    const wrapper = WRAPPER_FLAG_ONLY.find((w) => w.re.test(base));

    let unwrapped = false;
    if (wrapper || base === 'sudo' || base === 'env' || base === 'timeout' || base === 'nohup' || base === 'nice' || base === 'taskset') {
      // Skip flags; flags with arguments (sudo -u <user>, env -i, -u <name>,
      // timeout <duration>, nice -n <val>) consume their following token.
      let idx = 1;
      while (idx < tokens.length) {
        const tok = tokens[idx]!;
        if (!tok.startsWith('-')) {
          // env VAR=value assignments belong to env, not the wrapped command.
          if (base === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
            idx += 1;
            continue;
          }
          // timeout <duration> — the first bare token is the duration.
          if (base === 'timeout' && idx === 1) {
            idx += 1;
            continue;
          }
          if (idx < tokens.length) {
            current = tokens.slice(idx).join(' ');
            unwrapped = true;
          }
          break;
        }
        const flag = tok.toLowerCase();
        const consumesArg =
          (base === 'sudo' && (flag === '-u' || flag === '-g')) ||
          (base === 'env' && flag === '-u') ||
          (base === 'timeout' && !/^-\d/.test(tok)) ||
          (base === 'nice' && flag === '-n') ||
          (base === 'taskset' && (flag === '-c' || flag === '-p'));
        idx += consumesArg ? 2 : 1;
      }
      if (!unwrapped && idx < tokens.length) {
        current = tokens.slice(idx).join(' ');
        unwrapped = true;
      }
      if (!unwrapped) break;
    } else {
      // bash|sh|zsh|dash [-flags] -c <quoted command> / powershell -Command / cmd /c
      const shell = /^(bash|sh|zsh|dash)$/i.test(base);
      const ps = /^(powershell|pwsh)$/i.test(base);
      const cmd = /^cmd$/i.test(base);
      if (shell) {
        // Combined short flags (`-lc`, `-ic`, `-sc`, `-ec`) carry the
        // command token too — `bash -lc "cmd"` must unwrap like `-c`.
        const ci = tokens.findIndex((t) => t === '-c' || /^-[a-z]*c[a-z]*$/i.test(t));
        if (ci !== -1 && ci + 1 < tokens.length) {
          current = tokens.slice(ci + 1).join(' ');
          unwrapped = true;
        }
      } else if (ps) {
        const ci = tokens.findIndex((t) => t.toLowerCase() === '-command' || t.toLowerCase() === '-c');
        if (ci !== -1 && ci + 1 < tokens.length) {
          current = tokens.slice(ci + 1).join(' ');
          unwrapped = true;
        }
      } else if (cmd) {
        const ci = tokens.findIndex((t) => t === '/c' || t.toLowerCase() === '/c');
        if (ci !== -1 && ci + 1 < tokens.length) {
          current = tokens.slice(ci + 1).join(' ');
          unwrapped = true;
        }
      }
    }
    if (!unwrapped) break;
  }
  // PowerShell invocation block: `& { Get-Content .env }` → `Get-Content .env`.
  let block = current.trim();
  if (/^&\s*\{/.test(block)) {
    block = block.replace(/^&\s*\{\s*/, '').replace(/\}\s*$/, '').trim();
    current = block;
  }
  // Remove one layer of surrounding quotes (matching single or double).
  const first = current[0];
  if (first === '"' || first === "'") {
    const last = current[current.length - 1];
    if (last === first) current = current.slice(1, -1).trim();
  }
  return current;
}

/** Extract executable base + remaining args from one command segment. */
export function splitCommandParts(segment: string): { base: string; rest: string } {
  const trimmed = segment.trim();
  const spaceIdx = trimmed.search(/\s/);
  const firstToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  const token = firstToken.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return { base: token.toLowerCase(), rest };
}

// ─── Credential detection ───────────────────────────────────────────────────

const CREDENTIAL_PATH_RE =
  /(?:^|[\s"'`\\/:])\.env(?![A-Za-z0-9._-]*\.example\b)(?:\.[A-Za-z0-9_-]+)?\b(?:\s|$|['"`\\/:])|(?:^|[\s"'`\\/:])(?:id_rsa|id_ed25519|id_dsa|credentials\.json|\.pem|\.p12|\.pfx)(?:\s|$|['"`\\/:])|\.ssh[\\/]|\.aws[\\/]credentials|\.git-credentials|secrets[\\/]/i;
/** Merged read tools: #86 (strings, sed) + #87 (cat..printf) + gaps (rg, grep, Select-String). */
const CREDENTIAL_DUMP_TOOLS =
  /^\s*(?:cat|type|get-content|more|less|head|tail|bat|printf|strings|sed|rg|grep|select-string)\s+/i;
const CREDENTIAL_VAR_ECHO = /(?:echo|printenv|env|set)\s+[^\s]*(?:API[_]?KEY|TOKEN|SECRET|PASSWORD)/i;
const PICKAXE_LOG = /\bgit\s+log\s+--all\s+--pickaxe\b/i;
const CREDENTIAL_TRANSFER_TOOLS =
  /^\s*(?:cp|mv|scp|rsync|copy-item|aws\s+s3\s+cp|gsutil\s+cp|az\s+storage\s+blob\s+copy)\s+/i;
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

// ─── High-consequence tool patterns ─────────────────────────────────────────

const DANGEROUS_TOOL_PATTERNS: Array<{ re: RegExp; capability: CapabilityId; semantic: CommandSemanticClass }> = [
  { re: /\bterraform\s+(apply|destroy)\b/i, capability: 'production_deploy', semantic: 'infrastructure_mutation' },
  { re: /\b(kubectl|helm)\s+(apply|delete|create|scale|rollout)\b/i, capability: 'production_deploy', semantic: 'infrastructure_mutation' },
  { re: /\b(aws|gcloud|az)\s+(iam|organizations?)\b/i, capability: 'security_policy_change', semantic: 'infrastructure_mutation' },
  { re: /\b(aws|gcloud|az)\s+billing\b/i, capability: 'security_policy_change', semantic: 'financial_external_effect' },
  { re: /\b(docker|podman)\s+rm\s+-f\b/i, capability: 'destructive_data_delete', semantic: 'delete_destructive' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, capability: 'release', semantic: 'deploy' },
  { re: /\b(fly|vercel|netlify|railway|render)\s+(deploy|release)\b/i, capability: 'production_deploy', semantic: 'infrastructure_mutation' },
  { re: /\b(drop|truncate)\s+(table|database|schema)\b/i, capability: 'destructive_data_delete', semantic: 'infrastructure_mutation' },
  { re: /\bdelete\s+from\b/i, capability: 'destructive_data_delete', semantic: 'infrastructure_mutation' },
];

const TEST_RUNNER_RE =
  /^(?:pytest|npx\s+jest|npx\s+vitest|npx\s+mocha|cargo\s+test|go\s+test|dotnet\s+test|node\s+--test|tsx\s+--test|npm\s+test|npm\s+run\s+test)/i;
const BUILD_RE =
  /^(?:npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build|cargo\s+build|go\s+build|dotnet\s+build|make(?:\s|$))/i;
const LINT_RE =
  /^(?:npm\s+run\s+lint|pnpm\s+run\s+lint|yarn\s+lint|npx\s+eslint|eslint\b)/i;
const TYPECHECK_RE =
  /^(?:npx\s+tsc(?:\s+--noEmit)?|tsc\s+--noEmit|npm\s+run\s+typecheck|pnpm\s+run\s+typecheck)/i;

function extractPrNumber(tokens: string[], startIdx: number): string | undefined {
  for (let i = startIdx; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith('-')) continue;
    if (/^\d+$/.test(tok)) return tok;
    if (/^#\d+$/.test(tok)) return tok.slice(1);
  }
  return undefined;
}

function inferDeployEnvironment(raw: string): string | undefined {
  if (/(?:^|[\s=])--prod(?:uction)?(?:\s|$)/i.test(raw) || /\bproduction\b/i.test(raw)) {
    return 'production';
  }
  if (/(?:^|[\s=])--stag(?:e|ing)(?:\s|$)/i.test(raw) || /\bstaging\b/i.test(raw)) {
    return 'staging';
  }
  const envFlag = raw.match(/--env(?:ironment)?(?:=|\s+)(\S+)/i);
  if (envFlag?.[1]) {
    const v = envFlag[1].toLowerCase();
    if (v === 'prod') return 'production';
    if (v === 'stage') return 'staging';
    return v;
  }
  return undefined;
}

// ─── Git global options that consume a following argument ───────────────────

const GIT_OPT_WITH_ARG = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--exec-path',
  '--git-path',
  '--object-dir',
]);

function gitVerbAndArgs(tokens: string[]): { verb: string; args: string[] } {
  let idx = 1;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok === '--') {
      idx += 1;
      break;
    }
    if (tok.startsWith('-')) {
      if (tok === '-c') {
        idx += 2; // -c <key=value> — the value belongs to the option
        continue;
      }
      if (tok.startsWith('-c') && tok.length > 2) {
        idx += 1; // -ckey=value attached form
        continue;
      }
      if (GIT_OPT_WITH_ARG.has(tok)) {
        idx += 2; // -C <path> / --git-dir <path> / ... — the next token belongs
        continue;
      }
      idx += 1;
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return { verb: '', args: [] };
  return { verb: tokens[idx]!.toLowerCase(), args: tokens.slice(idx + 1) };
}

function cmd(
  capability: CapabilityId | 'unknown',
  semantic: CommandSemanticClass,
  fields: Partial<DecodedCommand> = {},
): DecodedCommand {
  return { capability, semantic, force: false, delete: false, ...fields };
}

// ─── Git family ─────────────────────────────────────────────────────────────

function decodeGit(tokens: string[]): DecodedCommand {
  const { verb, args } = gitVerbAndArgs(tokens);
  if (verb === '') return cmd('unknown', 'unrecognized', { ambiguous: true });

  const hasForce = args.some(
    (a) =>
      a === '--force' ||
      a === '--mirror' ||
      a.startsWith('--force-with-lease') ||
      // Combined short flags (`-uf`, `-ff`, `-fu`) include force.
      (a.startsWith('-') && /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)),
  );
  const hasDelete = args.some((a) => a === '--delete' || (a === '-d' && verb === 'push'));

  switch (verb) {
    case 'push': {
      const remote = args.find((a) => !a.startsWith('-')) ?? 'origin';
      // `git push --all` / `--tags` publish every branch — scope expansion.
      if (args.some((a) => a === '--all' || a === '--tags')) {
        return cmd('scope_expansion', 'git_push', { remote, force: false, delete: false });
      }
      const refspec = args.find((a) => !a.startsWith('-') && a.includes(':'));
      const plainRef = args.filter((a) => !a.startsWith('-') && !a.includes(':'))[1];
      const plusForce =
        (refspec !== undefined && refspec.startsWith('+')) ||
        args.some((a) => !a.startsWith('-') && a.startsWith('+'));
      const force = hasForce || plusForce;
      if (hasDelete || (refspec !== undefined && (refspec.startsWith(':') || refspec.endsWith(':')))) {
        let deleteTarget: string | undefined;
        if (refspec !== undefined && refspec.startsWith(':')) {
          deleteTarget = refspec.slice(1);
        } else if (refspec !== undefined && refspec.endsWith(':')) {
          deleteTarget = refspec.replace(/^\+/, '').slice(0, -1);
        } else if (hasDelete) {
          const positional = args.filter((a) => !a.startsWith('-'));
          deleteTarget = positional[1];
        }
        const dest = deleteTarget
          ? {
              destinationBranch: deleteTarget
                .replace(/^refs\/heads\//, '')
                .replace(/^heads\//, ''),
            }
          : {};
        return cmd('scope_expansion', 'git_push', { remote, force, delete: true, ...dest });
      }
      let destinationBranch: string | undefined;
      if (refspec !== undefined) {
        const [src, dst] = refspec.replace(/^\+/, '').split(':');
        if (!dst) return cmd('scope_expansion', 'git_push', { remote, force, delete: true });
        destinationBranch = dst.startsWith('refs/heads/') ? dst.slice('refs/heads/'.length) : dst.replace(/^heads\//, '');
        if (!src) return cmd('scope_expansion', 'git_push', { remote, force, delete: true });
      } else if (plainRef !== undefined) {
        destinationBranch = plainRef.replace(/^refs\/heads\//, '');
      }
      const dest = destinationBranch !== undefined ? { destinationBranch } : {};
      return force
        ? cmd('force_push', 'git_push', { remote, ...dest, force: true, delete: false })
        : cmd('push_feature_branch', 'git_push', { remote, ...dest, force: false, delete: false });
    }
    case 'commit':
      if (args.includes('--amend')) {
        return cmd('shared_history_rewrite', 'git_history_rewrite');
      }
      return cmd('commit_ship_set', 'git_commit');
    case 'reset': {
      const resetDest = args.find((a) => !a.startsWith('-'));
      return args.includes('--hard')
        ? cmd(
            'shared_history_rewrite',
            'git_history_rewrite',
            resetDest ? { destinationBranch: resetDest } : {},
          )
        : cmd('inspect_repository', 'read_local');
    }
    case 'rebase': {
      const ontoIdx = args.indexOf('--onto');
      const rebaseDest =
        ontoIdx >= 0 && args[ontoIdx + 1] && !args[ontoIdx + 1]!.startsWith('-')
          ? args[ontoIdx + 1]
          : args.find((a) => !a.startsWith('-'));
      return cmd(
        'shared_history_rewrite',
        'git_history_rewrite',
        rebaseDest ? { destinationBranch: rebaseDest } : {},
      );
    }
    case 'clean':
      // `-f` may be combined (`-xdf`, `-fd`) or written `--force`.
      return args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === '--force')
        ? cmd('destructive_data_delete', 'git_history_rewrite')
        : cmd('inspect_repository', 'read_local');
    case 'branch': {
      if (args.includes('-D') || (args.includes('--delete') && args.includes('-f'))) {
        return cmd('destructive_data_delete', 'git_history_rewrite', { delete: true });
      }
      if (args.includes('-d') || args.includes('--delete')) {
        return cmd('destructive_data_delete', 'git_history_rewrite', { delete: true });
      }
      return cmd('create_task_branch', 'write_local_reversible');
    }
    case 'remote':
      if (args[0] === 'add' || args[0] === 'remove' || args[0] === 'set-url') {
        const remoteName = args[1] && !args[1].startsWith('-') ? args[1] : undefined;
        return cmd('scope_expansion', 'git_history_rewrite', {
          delete: args[0] === 'remove',
          ...(remoteName ? { target: remoteName, destinationBranch: remoteName } : {}),
        });
      }
      return cmd('inspect_repository', 'read_local');
    case 'fetch':
    case 'pull':
      return cmd('inspect_repository', 'read_local');
    case 'show':
    case 'cat-file': {
      const target = args.join(' ');
      if (CREDENTIAL_PATH_RE.test(target)) {
        return cmd('expose_credentials', 'credential_access');
      }
      return cmd('inspect_repository', 'read_local');
    }
    case 'checkout':
    case 'switch':
      return cmd('create_task_branch', 'write_local_reversible');
    case 'worktree':
      if (args[0] === 'remove') return cmd('delete_task_temp', 'delete_local', { delete: true });
      return cmd('create_worktree', 'write_local_reversible');
    case 'status':
    case 'diff':
    case 'log': {
      if (args.some((a) => a.includes('--pickaxe'))) {
        return cmd('expose_credentials', 'credential_access');
      }
      return cmd('inspect_repository', 'read_local');
    }
    case 'show-ref':
    case 'ls-files':
      return cmd('inspect_repository', 'read_local');
    case 'stash':
      if (args[0] === 'drop' || args[0] === 'clear') {
        return cmd('destructive_data_delete', 'git_history_rewrite', { delete: true });
      }
      return cmd('inspect_repository', 'read_local');
    case 'tag':
      return cmd('release', 'deploy', { delete: args[0] === '-d' || args[0] === '--delete' });
    case 'merge':
      return cmd('merge', 'git_push');
    default:
      if (verb === 'credential' || verb === 'update-ref' || verb === 'symbolic-ref' || verb === 'config') {
        return cmd('repo_admin', 'infrastructure_mutation');
      }
      return cmd('unknown', 'unrecognized', { ambiguous: true });
  }
}

// ─── gh family ──────────────────────────────────────────────────────────────

function ghApiMethod(tokens: string[]): string {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === '--method' || tok === '-X') {
      const next = tokens[i + 1]?.toUpperCase();
      if (next !== undefined && /^(GET|POST|PATCH|PUT|DELETE|HEAD)$/.test(next)) return next;
    } else if (tok.startsWith('--method=')) {
      const m = tok.slice('--method='.length).toUpperCase();
      if (/^(GET|POST|PATCH|PUT|DELETE|HEAD)$/.test(m)) return m;
    } else if (tok.startsWith('-X') && tok.length > 2) {
      const m = tok.slice(2).toUpperCase();
      if (/^(GET|POST|PATCH|PUT|DELETE|HEAD)$/.test(m)) return m;
    }
  }
  return 'GET';
}

function decodeGh(tokens: string[]): DecodedCommand {
  const sub = tokens[1]?.toLowerCase();
  if (sub === 'api') {
    const endpoint = tokens.find((tok) => /^(\/|repos\/|user\/|orgs\/)/.test(tok)) ?? '';
    const method = ghApiMethod(tokens);
    const privileged =
      /(refs|releases|workflows|gists|statuses|secrets|environments|actions\/runs\/(?!\d+\/logs))/i.test(
        endpoint,
      );
    if (privileged && /^(POST|PATCH|PUT|DELETE)$/i.test(method)) {
      return cmd('repo_admin', 'infrastructure_mutation', { delete: /^DELETE$/i.test(method) });
    }
    if (
      /^\/(repos\/[^/]+\/[^/]+\/)?(pulls|issues|checks|actions\/runs|commits)/i.test(endpoint) &&
      /^GET$/i.test(method)
    ) {
      return cmd('pr_inspect', 'read_local');
    }
    if (/secrets|environments/i.test(endpoint)) {
      return cmd('security_policy_change', 'infrastructure_mutation');
    }
    return cmd('pr_inspect', 'read_local');
  }
  if (sub === 'pr') {
    const verb = tokens[2]?.toLowerCase();
    if (verb === 'create') {
      if (tokens.includes('--draft')) return cmd('pr_create_draft', 'create_pr');
      return cmd('pr_mark_ready', 'create_pr');
    }
    if (verb === 'merge') {
      const pr = extractPrNumber(tokens, 3);
      return cmd('merge', 'git_push', pr ? { target: pr } : {});
    }
    if (verb === 'ready') {
      const pr = extractPrNumber(tokens, 3);
      return cmd('pr_mark_ready', 'create_pr', pr ? { target: pr } : {});
    }
    return cmd('pr_inspect', 'read_local');
  }
  if (sub === 'release') {
    if (tokens[2]?.toLowerCase() === 'create') return cmd('release', 'deploy');
    if (tokens[2]?.toLowerCase() === 'delete') return cmd('release', 'deploy', { delete: true });
    return cmd('release', 'deploy');
  }
  if (sub === 'run') {
    if (tokens[2]?.toLowerCase() === 'rerun') return cmd('ci_rerun_transient', 'read_local');
    return cmd('ci_inspect', 'read_local');
  }
  if (sub === 'workflow' || sub === 'workflows') {
    const verb = tokens[2]?.toLowerCase();
    if (verb === 'run' || verb === 'dispatch') return cmd('production_deploy', 'infrastructure_mutation');
    return cmd('ci_inspect', 'read_local');
  }
  return cmd('unknown', 'unrecognized', { ambiguous: true });
}

// ─── Non-git/gh family ──────────────────────────────────────────────────────

function decodeNonGit(tokens: string[], raw: string): DecodedCommand {
  const base = tokens[0]?.toLowerCase() ?? '';

  // Credential reads: merged tool list + credential-path reference.
  if (isCredentialExposureCommand(raw)) {
    return cmd('expose_credentials', 'credential_access');
  }

  // Credential transfers.
  if (CREDENTIAL_TRANSFER_TOOLS.test(raw) && CREDENTIAL_PATH_RE.test(raw)) {
    return cmd('expose_credentials', 'credential_access');
  }

  // Network clients: default network_read; messaging detection can escalate.
  if (base === 'curl' || base === 'wget') {
    if (
      /\b(POST|PUT|PATCH|DELETE)\b/i.test(raw) &&
      /\b(webhook|slack|discord|telegram|zapier|make\.com)\b/i.test(raw)
    ) {
      return cmd('run_local_command', 'external_message');
    }
    return cmd('run_local_command', 'network_read');
  }

  if (/\b(msgsend|slack|discord|sendmail|mail|twilio|sendgrid)\b/i.test(raw)) {
    return cmd('run_local_command', 'external_message');
  }

  // High-consequence tools.
  for (const { re, capability, semantic } of DANGEROUS_TOOL_PATTERNS) {
    if (re.test(raw)) {
      if (capability === 'production_deploy') {
        const environment = inferDeployEnvironment(raw);
        return cmd(capability, semantic, environment ? { environment } : {});
      }
      return cmd(capability, semantic);
    }
  }

  // Test / build / lint / typecheck runners.
  if (TEST_RUNNER_RE.test(raw)) return cmd('run_tests', 'test_local');
  if (TYPECHECK_RE.test(raw)) return cmd('run_typecheck', 'test_local');
  if (LINT_RE.test(raw)) return cmd('run_lint', 'test_local');
  if (BUILD_RE.test(raw)) return cmd('run_build', 'test_local');

  // Package managers.
  if (base === 'npm' || base === 'pnpm' || base === 'yarn') {
    if (/\b(install|add|ci|dlx)\b/i.test(raw)) return cmd('run_local_command', 'install_dependency');
    return cmd('run_local_command', 'write_local_reversible');
  }
  if (base === 'pip' || base === 'pip3' || base === 'poetry' || base === 'uv') {
    if (/\b(install|add)\b/i.test(raw)) return cmd('run_local_command', 'install_dependency');
  }
  if (base === 'go' && /\b(install|get)\b/i.test(raw)) return cmd('run_local_command', 'install_dependency');
  if (base === 'cargo' && /\b(install|add)\b/i.test(raw)) return cmd('run_local_command', 'install_dependency');

  // Deletes.
  if (base === 'rm' || base === 'rmdir') {
    // Force/recursive may be combined in one token (`-rf`, `-fr`) or
    // spread across tokens (`rm -r -f artifacts`) — either form is
    // destructive.
    const shortFlags = raw.match(/(?:^|\s)-[a-zA-Z]+/g) ?? [];
    const destructive =
      /-[a-zA-Z]*[rf][a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force|\/s\b/i.test(raw) ||
      // Matches carry the leading separator (" -r") — anchor past it.
      shortFlags.some((f) => /^\s*-[a-zA-Z]*[rf]/.test(f));
    return destructive
      ? cmd('destructive_data_delete', 'delete_destructive')
      : cmd('run_local_command', 'delete_local');
  }
  if (base === 'remove-item' || base === 'del' || base === 'erase') {
    return /-recurse|-r\b|-f\b|-force|\/s\b|\/q\b/i.test(raw)
      ? cmd('destructive_data_delete', 'delete_destructive')
      : cmd('run_local_command', 'delete_local');
  }

  if (TEST_RUNNER_RE.test(raw)) return cmd('run_tests', 'test_local');

  const evalDecoded = decodeInterpreterEval(tokens);
  if (evalDecoded) return evalDecoded;

  if (isArbitraryInterpreterInvocation(tokens)) {
    return cmd('run_arbitrary_code', 'unrecognized');
  }

  // Recognized safe/reversible local engineering (semantic stays
  // 'unrecognized' at the autonomy layer; the PDP/lease is the authority).
  return cmd('run_local_command', 'unrecognized');
}

const INTERPRETER_BASES = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'deno',
  'tsx',
  'ts-node',
  'bun',
]);

const SCRIPT_FILE_RE = /\.(cjs|mjs|js|ts|tsx|jsx|py|rb|pl|ps1)$/i;

function isArbitraryInterpreterInvocation(tokens: readonly string[]): boolean {
  const base = (tokens[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (INTERPRETER_BASES.has(base)) return true;
  if (base === 'pwsh' || base === 'powershell') {
    return tokens.some((t) => t === '-File' || t === '-file' || SCRIPT_FILE_RE.test(t));
  }
  if (base === 'wscript' || base === 'cscript') return true;
  return false;
}

function extractInterpreterEvalPayload(tokens: readonly string[]): string | null {
  const base = (tokens[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (!INTERPRETER_BASES.has(base)) return null;
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i]!.toLowerCase();
    if (flag === '-e' || flag === '-c' || flag === '--eval' || flag === '--command') {
      return tokens[i + 1] ?? null;
    }
  }
  return null;
}

function extractEmbeddedToolCommands(payload: string): string[] {
  const found: string[] = [];
  const re = /\b((?:git|gh|terraform|vercel|kubectl|helm|npm|pnpm|yarn)\s+[^'"\\;\n]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(payload)) !== null) {
    found.push(match[1]!.trim());
  }
  return found;
}

/**
 * node -e / python -c carriers must not become run_local_command when the
 * payload embeds a privileged git/gh/deploy command.
 */
function decodeInterpreterEval(tokens: readonly string[]): DecodedCommand | null {
  const payload = extractInterpreterEvalPayload(tokens);
  if (!payload) return null;
  const embedded = extractEmbeddedToolCommands(payload);
  let best: DecodedCommand | null = null;
  for (const fragment of embedded) {
    const decoded = decodeCommand(fragment);
    if (
      decoded.capability === 'run_local_command' &&
      decoded.semantic === 'unrecognized'
    ) {
      continue;
    }
    if (best === null) {
      best = decoded;
      continue;
    }
    best = moreSevere(decoded.semantic, best.semantic) === decoded.semantic ? decoded : best;
  }
  return best;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Decode a full command string (possibly chained). Each segment is normalized
 * (wrapper unwrap) and decoded; the most severe semantic wins and its
 * capability/fields are returned. Quote-aware: separators inside quotes are
 * not boundaries.
 */
export function decodeCommand(command: string): DecodedCommand {
  const segments = splitChains(command);
  if (segments.length === 0) {
    return cmd('unknown', 'unrecognized', { ambiguous: true });
  }
  let best: DecodedCommand | null = null;
  for (const segment of segments) {
    const normalized = unwrapCommandWrappers(segment);
    // Wrapper unwrap can expose an inner chain (`sh -c "a && b"` → `a && b`);
    // re-split so every segment is decoded, not just the first.
    const innerSegments = splitChains(normalized);
    for (const inner of innerSegments) {
      const tokens = tokenize(inner);
      // First-token normalization: strip path prefixes and .exe (Windows
      // forms like `C:\tools\git.exe push` resolve to base `git`).
      const firstBase =
        tokens.length === 0 ? '' : tokens[0]!.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
      const decoded =
        tokens.length === 0
          ? cmd('unknown', 'unrecognized', { ambiguous: true })
          : firstBase === 'git'
            ? decodeGit(tokens)
            : firstBase === 'gh'
              ? decodeGh(tokens)
              : decodeNonGit(tokens, inner);
      if (best === null) {
        best = decoded;
      } else {
        best = moreSevere(decoded.semantic, best.semantic) === decoded.semantic ? decoded : best;
      }
    }
  }
  return best ?? cmd('unknown', 'unrecognized', { ambiguous: true });
}

/** Git-push gate per repo policy (rule 05: force / history / main). */
export function isGatedGitPush(command: string): boolean {
  // Wrapper-aware: evaluate every unwrapped segment — the same normalization
  // decodeCommand applies — so `bash -c "git push --force origin main"`
  // gates exactly like the plain form.
  const candidates = splitChains(command).flatMap((s) =>
    splitChains(unwrapCommandWrappers(s)),
  );
  if (candidates.length === 0) return false;
  return candidates.some(isGatedPushSegment);
}

/** Force/history/main push check for one unwrapped command segment. */
function isGatedPushSegment(segment: string): boolean {
  const tokens = tokenize(segment);
  // Same first-token normalization as decodeCommand: strip path prefixes and
  // `.exe` so wrapper forms (`C:\tools\git.exe push`, `/usr/bin/git push`)
  // resolve to base `git`.
  const gi = tokens.findIndex(
    (tok) => tok.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/i, '') === 'git',
  );
  if (gi === -1) return false;
  const pushIdx = tokens.findIndex((tok, i) => i > gi && tok.toLowerCase() === 'push');
  if (pushIdx === -1) return false;
  const args = tokens.slice(pushIdx + 1);
  return (
    args.some(
      (a) =>
        a === '--force' ||
        a === '--mirror' ||
        a === '--delete' ||
        a === '--all' ||
        a === '--tags' ||
        a.startsWith('--force-with-lease') ||
        (a.startsWith('-') && /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) ||
        (a.startsWith('+') && !a.startsWith('+-')) ||
        a.startsWith(':refs/') ||
        a === ':',
    ) || /\b(main|master)\b/.test(args.join(' '))
  );
}

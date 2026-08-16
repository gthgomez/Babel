/**
 * gitCommand.ts — structured parsing of git/gh command strings into
 * capability ActionRequests (V2 authority).
 *
 * This is defense in depth: the PDP decides on STRUCTURED fields (capability,
 * remote, source/dest branch, force, delete), not raw strings. Parsing is
 * best-effort argv normalization — where a command cannot be parsed safely
 * (aliases, env expansion, unclassifiable privileged surface) the parser
 * returns the closest safe mapping or `unknown` (fail-closed).
 *
 * Known residual risk (R8): `git -c alias.…`, env expansion, and indirection
 * through scripts can disguise intent; the harness deny layers (Claude deny +
 * hook, Codex forbidden rules) are the enforcement complement.
 */

import type { CapabilityId } from './capabilities.js';

export interface ParsedGitCommand {
  capability: CapabilityId;
  remote?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  force: boolean;
  delete: boolean;
  /** Repo visibility for repo_create ('public'|'internal' → gated by PDP). */
  visibility?: 'public' | 'private' | 'internal';
  /** Set when the raw command was unparseable but privileged-looking. */
  ambiguous?: boolean;
}

const CREDENTIAL_PATH = /(\.env|id_rsa|id_ed25519|credentials\.json|\.pem|\.p12|\.pfx|\.aws|\.ssh)/i;

/** Non-git/gh tools whose invocation is privileged/destructive by nature. */
const DANGEROUS_TOOL_PATTERNS: Array<{ re: RegExp; capability: CapabilityId }> = [
  { re: /\bterraform\s+(apply|destroy)\b/i, capability: 'production_deploy' },
  { re: /\b(kubectl|helm)\s+(apply|delete|rollout)\b/i, capability: 'production_deploy' },
  { re: /\b(aws|gcloud|az)\s+\S+\s+(iam|organizations?|billing)\b/i, capability: 'security_policy_change' },
  { re: /\b(docker|podman)\s+rm\s+-f\b/i, capability: 'destructive_data_delete' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, capability: 'release' },
  { re: /\b(fly|vercel|netlify|railway|render)\s+(deploy|release)\b/i, capability: 'production_deploy' },
  { re: /\b(drop|truncate)\s+(table|database|schema)\b/i, capability: 'destructive_data_delete' },
];

function tokens(cmd: string): string[] {
  // Simple argv split respecting double quotes; env expansion is NOT resolved
  // (documented residual risk — hooks/deny layers cover it).
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

export function parseGitCommand(cmd: string): ParsedGitCommand {
  const t = tokens(cmd);
  if (t.length === 0) {
    return { capability: 'unknown', force: false, delete: false, ambiguous: true };
  }
  const base = t[0]?.toLowerCase();

  // ── gh CLI ─────────────────────────────────────────────────────────────
  if (base === 'gh') {
    const sub = t[1]?.toLowerCase();
    if (sub === 'api') {
      // Endpoint-class gating (R8): refs/releases/workflows/gists/statuses
      // are privileged; GET-only inspection endpoints are read. gh api paths
      // have NO leading slash (repos/…, user/…, orgs/…).
      const endpoint =
        t.find((tok) => /^(\/|repos\/|user\/|orgs\/)/.test(tok)) ?? '';
      const method = t.find((tok) => /^(GET|POST|PATCH|PUT|DELETE|HEAD)$/i.test(tok)) ?? 'GET';
      const privileged = /(refs|releases|workflows|gists|statuses|secrets|environments|actions\/runs\/(?!\d+\/logs))/i.test(endpoint);
      if (privileged && /^(POST|PATCH|PUT|DELETE)$/i.test(method)) {
        return { capability: 'repo_admin', force: false, delete: /DELETE/i.test(method) };
      }
      if (/^\/(repos\/[^/]+\/[^/]+\/)?(pulls|issues|checks|actions\/runs|commits)/i.test(endpoint) && /^GET$/i.test(method)) {
        return { capability: 'pr_inspect', force: false, delete: false };
      }
      if (/secrets|environments/i.test(endpoint)) {
        return { capability: 'security_policy_change', force: false, delete: false };
      }
      return { capability: 'pr_inspect', force: false, delete: false };
    }
    if (sub === 'pr') {
      const verb = t[2]?.toLowerCase();
      if (verb === 'create') {
        if (t.includes('--draft')) return { capability: 'pr_create_draft', force: false, delete: false };
        return { capability: 'pr_mark_ready', force: false, delete: false };
      }
      if (verb === 'merge') return { capability: 'merge', force: false, delete: false };
      if (verb === 'ready') return { capability: 'pr_mark_ready', force: false, delete: false };
      // view/list/checks/diff/status = inspection
      return { capability: 'pr_inspect', force: false, delete: false };
    }
    if (sub === 'release') {
      if (t[2]?.toLowerCase() === 'create') return { capability: 'release', force: false, delete: false };
      if (t[2]?.toLowerCase() === 'delete') return { capability: 'release', force: false, delete: true };
      return { capability: 'release', force: false, delete: false };
    }
    if (sub === 'run') {
      const verb = t[2]?.toLowerCase();
      if (verb === 'rerun') return { capability: 'ci_rerun_transient', force: false, delete: false };
      // view/list/watch/log = inspection
      return { capability: 'ci_inspect', force: false, delete: false };
    }
    if (sub === 'workflow' || sub === 'workflows') {
      const verb = t[2]?.toLowerCase();
      if (verb === 'run' || verb === 'dispatch') {
        return { capability: 'production_deploy', force: false, delete: false };
      }
      return { capability: 'ci_inspect', force: false, delete: false };
    }
    if (sub === 'repo') {
      const verb = t[2]?.toLowerCase();
      if (verb === 'create') {
        // Visibility is a deterministic gate: public/internal = making material
        // public (Class C); private = bounded+reversible (lease-checked).
        const visibility = t.includes('--public')
          ? 'public'
          : t.includes('--internal')
            ? 'internal'
            : 'private';
        return {
          capability: 'repo_create',
          visibility,
          force: false,
          delete: false,
        };
      }
      // gh repo view/list/clone = inspection/local
      return { capability: 'inspect_repository', force: false, delete: false };
    }
    return { capability: 'unknown', force: false, delete: false, ambiguous: true };
  }

  // ── git CLI ─────────────────────────────────────────────────────────────
  if (base !== 'git') {
    // Non-git/gh commands: credential-read verbs against credential paths map
    // to expose_credentials (DENY_CREDENTIAL_READ); everything else is
    // unknown (DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT — fail-closed).
    const readVerbs = /^(cat|type|get-content|more|less|head|tail|strings|sed)$/i;
    const cmdText = t.join(' ');
    if (base && readVerbs.test(base) && CREDENTIAL_PATH.test(cmdText)) {
      return { capability: 'expose_credentials', force: false, delete: false };
    }
    if (base && /^(echo|printenv|env)$/i.test(base) && /(API[_-]?KEY|TOKEN|SECRET|PASSWORD)/i.test(cmdText)) {
      return { capability: 'expose_credentials', force: false, delete: false };
    }
    // Known-dangerous non-git tools (R8: "covertly invoke a privileged action
    // through an unclassified external tool") → gated capabilities.
    for (const { re, capability } of DANGEROUS_TOOL_PATTERNS) {
      if (re.test(cmdText)) {
        return { capability, force: false, delete: false };
      }
    }
    // Ordinary local engineering: bounded, reversible, task-scoped → local.
    // Privileged surfaces are classified above (git/gh/credentials/dangerous
    // tools); the harness deny layers gate known-dangerous tools (curl,
    // install, etc.).
    return { capability: 'run_local_command', force: false, delete: false };
  }

  // git -c / -C prefix handling
  let idx = 1;
  while (t[idx]?.startsWith('-') && idx < t.length - 1) idx += 1;
  const verb = t[idx]?.toLowerCase();
  const args = t.slice(idx + 1);

  const hasForce = args.some((a) => a === '--force' || a === '-f' || a === '--force-with-lease');
  const hasDelete = args.some((a) => a === '--delete' || a === '-d' && verb === 'push');

  switch (verb) {
    case 'push': {
      const remote = args.find((a) => !a.startsWith('-')) ?? 'origin';
      const refspec = args.filter((a) => !a.startsWith('-') && a.includes(':'))[0];
      const plainRef = args.filter((a) => !a.startsWith('-') && !a.includes(':'))[1];
      if (hasDelete || args.some((a) => a.startsWith(':refs/') || a === ':')) {
        return { capability: 'scope_expansion', remote, force: hasForce, delete: true };
      }
      let dest: string | undefined;
      if (refspec) {
        const [src, dst] = refspec.split(':');
        if (!dst) {
          // "src:" = delete the remote ref
          return { capability: 'scope_expansion', remote, force: hasForce, delete: true };
        }
        dest = dst.startsWith('refs/heads/') ? dst.slice('refs/heads/'.length) : dst.replace(/^heads\//, '');
        if (!src && hasDelete) {
          return { capability: 'scope_expansion', remote, force: hasForce, delete: true };
        }
      } else if (plainRef) {
        dest = plainRef.replace(/^refs\/heads\//, '');
      }
      if (hasForce) {
        return {
          capability: 'force_push',
          remote,
          ...(dest !== undefined ? { destinationBranch: dest } : {}),
          force: true,
          delete: false,
        };
      }
      return {
        capability: 'push_feature_branch',
        remote,
        ...(dest !== undefined ? { destinationBranch: dest } : {}),
        force: false,
        delete: false,
      };
    }
    case 'commit':
      if (args.includes('--amend')) {
        return { capability: 'shared_history_rewrite', force: false, delete: false };
      }
      return { capability: 'commit_ship_set', force: false, delete: false };
    case 'reset':
      if (args.includes('--hard')) {
        return { capability: 'shared_history_rewrite', force: false, delete: false };
      }
      return { capability: 'inspect_repository', force: false, delete: false };
    case 'rebase':
      return { capability: 'shared_history_rewrite', force: false, delete: false };
    case 'clean':
      if (args.some((a) => /^-f/.test(a))) {
        return { capability: 'destructive_data_delete', force: false, delete: false };
      }
      return { capability: 'inspect_repository', force: false, delete: false };
    case 'branch': {
      if (args.includes('-D') || args.includes('--delete') && args.includes('-f')) {
        return { capability: 'destructive_data_delete', force: false, delete: true };
      }
      if (args.includes('-d') || args.includes('--delete')) {
        return { capability: 'destructive_data_delete', force: false, delete: true };
      }
      return { capability: 'create_task_branch', force: false, delete: false };
    }
    case 'remote':
      // remote add/set-url/remove can redirect publication targets
      if (args[0] === 'add' || args[0] === 'remove' || args[0] === 'set-url') {
        return { capability: 'scope_expansion', force: false, delete: args[0] === 'remove' };
      }
      return { capability: 'inspect_repository', force: false, delete: false };
    case 'fetch':
    case 'pull':
      return { capability: 'inspect_repository', force: false, delete: false };
    case 'show':
    case 'cat-file': {
      const target = args.join(' ');
      if (CREDENTIAL_PATH.test(target)) {
        return { capability: 'expose_credentials', force: false, delete: false };
      }
      return { capability: 'inspect_repository', force: false, delete: false };
    }
    case 'checkout':
    case 'switch':
      return { capability: 'create_task_branch', force: false, delete: false };
    case 'worktree':
      if (args[0] === 'remove') return { capability: 'delete_task_temp', force: false, delete: true };
      return { capability: 'create_worktree', force: false, delete: false };
    case 'status':
    case 'diff':
    case 'log':
    case 'show-ref':
    case 'ls-files':
      return { capability: 'inspect_repository', force: false, delete: false };
    case 'stash':
      if (args[0] === 'drop' || args[0] === 'clear') {
        return { capability: 'destructive_data_delete', force: false, delete: true };
      }
      return { capability: 'inspect_repository', force: false, delete: false };
    case 'tag':
      return { capability: 'release', force: false, delete: args[0] === '-d' || args[0] === '--delete' };
    case 'merge':
      return { capability: 'merge', force: false, delete: false };
    default:
      // git credential / config / update-ref / symbolic-ref are privileged surfaces
      if (verb === 'credential' || verb === 'update-ref' || verb === 'symbolic-ref') {
        return { capability: 'repo_admin', force: false, delete: false };
      }
      if (verb === 'config') {
        return { capability: 'repo_admin', force: false, delete: false };
      }
      return { capability: 'unknown', force: false, delete: false, ambiguous: true };
  }
}

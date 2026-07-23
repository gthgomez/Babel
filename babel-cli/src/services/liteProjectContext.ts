import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { buildRepoMap, type RepoMap } from './indexer.js';
import { readShallowTargetListing, targetBasename } from './targetResolver.js';
import { runGitCommand } from '../utils/gitExec.js';
import { WorkspaceScanner } from './workspaceDiscovery.js';

export interface ReadLiteProjectContextOptions {
  projectRoot: string;
  workspaceRoot?: string | null;
  task?: string;
  requiredReads?: string[];
  maxCharsPerFile?: number;
  maxRequiredReads?: number;
  includeRepoMap?: boolean;
  maxRepoMapEntries?: number;
}

export function trimForPrompt(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;
}

function formatDirectoryListing(projectRoot: string): string {
  const listing = readShallowTargetListing(projectRoot);
  if (listing.length === 0) {
    return 'No shallow directory listing was available.';
  }
  return listing.map((entry) => `- ${entry}`).join('\n');
}

function taskMentionsTarget(task: string, projectRoot: string): boolean {
  const base = targetBasename(projectRoot).toLowerCase();
  return base.length > 0 && task.toLowerCase().includes(base.toLowerCase());
}

/**
 * Resolve `@include <relative-path>` directives in file content.
 *
 * Lines matching `@include <relative-path>` are replaced with the referenced
 * file's content, indented with "  > " prefix. Includes are resolved
 * recursively up to `depth` levels (callers should start at 2 to prevent
 * deep cycles). Paths are resolved relative to `root` (the directory
 * containing the file being processed).
 */
export function resolveIncludes(content: string, root: string, depth: number): string {
  if (depth <= 0) {
    return content;
  }
  const lines = content.split('\n');
  const out: string[] = [];
  const includeRe = /^@include\s+(.+)$/;

  for (const line of lines) {
    const match = line.match(includeRe);
    if (match) {
      const includePath = match[1]!.trim();
      const resolvedPath = join(root, includePath);
      if (existsSync(resolvedPath)) {
        try {
          const st = statSync(resolvedPath);
          const MAX_INCLUDE_BYTES = 64 * 1024; // 64 KB per included file
          if (st.size > MAX_INCLUDE_BYTES) {
            out.push(`  > [too large: ${includePath} (${st.size} bytes)]`);
          } else {
            const includedContent = readFileSync(resolvedPath, 'utf-8');
            const resolvedIncluded = resolveIncludes(
              includedContent,
              dirname(resolvedPath),
              depth - 1,
            );
            const indented = resolvedIncluded
              .split('\n')
              .map((l) => `  > ${l}`)
              .join('\n');
            out.push(indented);
          }
        } catch {
          out.push(`  > [unreadable: ${includePath}]`);
        }
      } else {
        out.push(`  > [missing: ${includePath}]`);
      }
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

function readFileSnippet(repoPath: string, relativePath: string, maxChars: number): string | null {
  const path = join(repoPath, relativePath);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const resolved = resolveIncludes(raw, dirname(path), 2);
    return trimForPrompt(resolved, maxChars);
  } catch {
    return '[unreadable]';
  }
}

export function formatRepoMapPromptSection(repoMap: RepoMap, maxEntries = 30): string {
  const entries = repoMap.entries.slice(0, Math.max(1, maxEntries));
  if (entries.length === 0) {
    return '## Repo Map (symbols)\nNo indexed source files were available.';
  }
  const lines = entries.map((entry) => {
    const symbolText = entry.symbols.length > 0 ? ` — ${entry.symbols.slice(0, 6).join(', ')}` : '';
    return `- ${entry.path}${symbolText}`;
  });
  return ['## Repo Map (symbols)', `Files indexed: ${repoMap.files_indexed}`, ...lines].join('\n');
}

// Batch 3 #9: Memoized git info — git metadata is stable within a session
const gitInfoCache = new Map<string, { info: string | null; ts: number }>();
const GIT_INFO_CACHE_TTL_MS = 60_000;

// R1: Collect lightweight git metadata so agents know repo identity
function collectGitInfo(root: string): string | null {
  const cached = gitInfoCache.get(root);
  if (cached && Date.now() - cached.ts < GIT_INFO_CACHE_TTL_MS) {
    return cached.info;
  }
  let result: string | null = null;
  try {
    const head = runGitCommand(['rev-parse', '--short', 'HEAD'], root, { timeoutMs: 5000 });
    const branch = runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], root, { timeoutMs: 5000 });
    const remote = runGitCommand(['remote', 'get-url', 'origin'], root, { timeoutMs: 5000 });
    const parts: string[] = [];
    if (branch.status === 0 && branch.stdout.trim()) {
      parts.push(`branch: ${branch.stdout.trim()}`);
    }
    if (head.status === 0 && head.stdout.trim()) {
      parts.push(`HEAD: ${head.stdout.trim()}`);
    }
    if (remote.status === 0 && remote.stdout.trim()) {
      // Strip credentials from remote URLs for safety
      const safe = remote.stdout.trim().replace(/\/\/[^@]+@/, '//<credential>@');
      parts.push(`remote origin: ${safe}`);
    }
    result = parts.length > 0 ? parts.join('\n') : null;
  } catch {
    result = null;
  }
  gitInfoCache.set(root, { info: result, ts: Date.now() });
  return result;
}

function buildLiteProjectContextBase(options: ReadLiteProjectContextOptions): string {
  const root = resolve(options.projectRoot);
  const maxChars = options.maxCharsPerFile ?? 1800;
  const maxRequiredReads = options.maxRequiredReads ?? 6;
  const snippets: string[] = [];

  snippets.push(`Target root: ${root}`);
  if (options.workspaceRoot && resolve(options.workspaceRoot) !== root) {
    snippets.push(
      `Workspace root: ${resolve(options.workspaceRoot)}\n` +
        'The target root is a child project inside this workspace. Prioritize target-local files over parent workspace summaries. Parent workspace docs are reference-only and must not be read via tools during read-only discovery.',
    );
  }

  // R1: Git metadata — gives agents repo identity (name, branch, remote)
  const gitInfo = collectGitInfo(root);
  if (gitInfo) {
    snippets.push(`## Git Metadata\n${gitInfo}`);
  }
  snippets.push(`## Shallow Directory Listing\n${formatDirectoryListing(root)}`);

  if (options.task && taskMentionsTarget(options.task, root)) {
    snippets.push(
      `## Target Name Evidence\nThe task mentions "${targetBasename(root)}", which matches the target directory basename.`,
    );
  }

  const defaultCandidates = [
    'CLAUDE.md',
    'AGENTS.md',
    'Agent.md',
    'ENGINEERING.md',
    'README.md',
    'PROJECT_CONTEXT.md',
    'package.json',
  ];
  const requiredReads = options.requiredReads ?? [];
  const orderedPaths = [...new Set([...requiredReads, ...defaultCandidates])].slice(
    0,
    maxRequiredReads + defaultCandidates.length,
  );

  const seen = new Set<string>();
  for (const relativePath of orderedPaths) {
    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    const snippet = readFileSnippet(root, relativePath, maxChars);
    if (snippet === null) {
      if (requiredReads.includes(relativePath)) {
        snippets.push(`## ${relativePath}\n[missing or unreadable]`);
      }
      continue;
    }
    snippets.push(`## ${relativePath}\n${snippet}`);
    if (snippets.length >= maxRequiredReads + 3) {
      break;
    }
  }

  if (snippets.length === 1) {
    return `Project root: ${root}\nNo summary files were found. Use the repo contract paths only.`;
  }
  return snippets.join('\n\n');
}

// Batch 3 #29: Auto-wire WorkspaceScanner results into project context
function buildWorkspaceContextSection(workspaceRoot: string, projectRoot: string): string | null {
  try {
    const resolvedWs = resolve(workspaceRoot);
    const resolvedPr = resolve(projectRoot);

    if (resolvedWs === resolvedPr) return null;

    const scanner = new WorkspaceScanner(resolvedWs);
    const allProjects = scanner.scanAllProjects();

    // Find which project our projectRoot belongs to
    const current = scanner.detectFromCwd(resolvedPr);
    const siblings = current
      ? allProjects.filter((p) => resolve(p.root) !== resolve(current.root))
      : allProjects;

    if (siblings.length === 0) return null;

    const lines: string[] = [
      '## Workspace Context',
      `Workspace root: ${resolvedWs}`,
      '',
      'Sibling projects:',
    ];

    for (const sibling of siblings) {
      const hasClaude = sibling.markers.includes('CLAUDE.md') ? 'yes' : 'no';
      const hasAgents = sibling.markers.includes('AGENTS.md') ? 'yes' : 'no';
      lines.push(
        `- **${sibling.name}** — root: \`${sibling.root}\`, CLAUDE.md: ${hasClaude}, AGENTS.md: ${hasAgents}`,
      );
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

export async function readLiteProjectContext(
  options: ReadLiteProjectContextOptions,
): Promise<string> {
  let base = buildLiteProjectContextBase(options);

  // Batch 3 #29: Auto-wire WorkspaceScanner results
  if (options.workspaceRoot) {
    const wsSection = buildWorkspaceContextSection(options.workspaceRoot, options.projectRoot);
    if (wsSection) {
      base = `${base}\n\n${wsSection}`;
    }
  }
  const shouldIncludeRepoMap = options.includeRepoMap !== false && Boolean(options.task?.trim());
  if (!shouldIncludeRepoMap) {
    return base;
  }

  try {
    const repoMap = await buildRepoMap(resolve(options.projectRoot), {
      limit: options.maxRepoMapEntries ?? 30,
    });
    return `${base}\n\n${formatRepoMapPromptSection(repoMap, options.maxRepoMapEntries ?? 30)}`;
  } catch {
    return base;
  }
}

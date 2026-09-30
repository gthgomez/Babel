// ─── Identity Loading ─────────────────────────────────────────────────────────
// Extracted from interactive.ts — session identity file loading with the
// 4-tier fallback hierarchy: project-local → workspace-meta → sibling examples → shipped defaults.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCachedRepoMap } from '../services/indexer.js';
import { formatRepoMapPromptSection, trimForPrompt } from '../services/liteProjectContext.js';
import type {
  IdentityDeliveredFragment,
  IdentityInstructionTier,
} from '../agent/instructionManifest.js';
import type { ReplContext } from './context.js';

/**
 * Deterministic (non-yielding) sibling scan, used by the synchronous
 * delivered-fragment resolver so the instruction manifest can record what was
 * actually delivered without introducing an async initialization step. This is
 * the single sibling-selection reader; the old async copy was removed so the
 * two readers cannot drift.
 */
function findSiblingExamplesSync(
  searchRoot: string,
  ownRoot: string,
  names: string[],
  limit: number,
): string[] {
  const results: string[] = [];
  // M1: this reader is synchronous (the manifest is built in a constructor and
  // in applyTurnPreparation), so it cannot yield. Bound the directory scan
  // instead of scanning an unbounded workspace synchronously on every turn.
  const MAX_DIRS_SCANNED = 200;
  let dirsScanned = 0;
  try {
    if (!fs.existsSync(searchRoot)) return results;
    const entries = fs.readdirSync(searchRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (dirsScanned >= MAX_DIRS_SCANNED) break;
      dirsScanned += 1;
      const dirPath = path.join(searchRoot, entry.name);
      if (path.resolve(dirPath) === path.resolve(ownRoot)) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      for (const name of names) {
        const filePath = path.join(dirPath, name);
        if (fs.existsSync(filePath)) {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const snippet = trimForPrompt(content, 800);
            results.push(`### ${entry.name}/${name}\n\`\`\`markdown\n${snippet}\n\`\`\``);
          } catch {
            // Skip unreadable
          }
          break;
        }
      }
      if (results.length >= limit) break;
    }
  } catch {
    // Non-fatal — examples are a nice-to-have
  }
  return results;
}

export interface SessionIdentityWithDisposition {
  systemContext: string;
  fragments: IdentityDeliveredFragment[];
}

interface LoadedIdentitySection {
  path: string;
  tier: IdentityInstructionTier;
  content: string;
  rawContent: string | null;
  truncated: boolean;
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readProjectOrWorkspaceIdentityFile(
  projectRoot: string,
  workspaceRoot: string,
  names: string[],
  maxChars: number,
): LoadedIdentitySection | null {
  // Tier 1: Project-local
  for (const name of names) {
    const localPath = path.join(projectRoot, name);
    if (fs.existsSync(localPath)) {
      try {
        const raw = fs.readFileSync(localPath, 'utf-8');
        return {
          path: localPath,
          tier: 'project',
          content: trimForPrompt(raw, maxChars),
          rawContent: raw,
          truncated: raw.length > maxChars,
        };
      } catch {
        continue;
      }
    }
  }

  // Tier 2: Workspace-meta (adversarial framing)
  if (path.resolve(workspaceRoot) !== path.resolve(projectRoot)) {
    for (const name of names) {
      const metaPath = path.join(workspaceRoot, name);
      if (fs.existsSync(metaPath)) {
        try {
          const raw = fs.readFileSync(metaPath, 'utf-8');
          const metaContent = trimForPrompt(raw, 2500);
          const projectName = path.basename(projectRoot);
          const adversarial = [
            `[No ${name} found in this project.]`,
            '',
            `## Workspace Template (${path.relative(workspaceRoot, metaPath)})`,
            '',
            '**Critically review this template against the current project.**',
            'What fits this specific codebase? What does not apply? What is missing?',
            'Adapt and improve it for **' + projectName + '** specifically.',
            'After answering the user, offer to save the improved version to ' +
              path.join(projectRoot, name) +
              '.',
            '',
            '```markdown',
            metaContent,
            '```',
          ].join('\n');
          return {
            path: metaPath,
            tier: 'workspace',
            content: adversarial,
            rawContent: raw,
            truncated: raw.length > 2500,
          };
        } catch {
          continue;
        }
      }
    }
  }

  return null;
}

function loadIdentityFileSectionSync(
  projectRoot: string,
  workspaceRoot: string,
  names: string[],
  maxChars: number,
): LoadedIdentitySection | null {
  const direct = readProjectOrWorkspaceIdentityFile(projectRoot, workspaceRoot, names, maxChars);
  if (direct) return direct;

  // Tier 3: Sibling examples
  const primaryName = names[0] ?? 'this file';
  const examples = findSiblingExamplesSync(workspaceRoot, projectRoot, names, 3);
  if (examples.length > 0) {
    const hint =
      primaryName === 'ENGINEERING.md'
        ? 'Reference examples from similar projects (use these patterns to suggest one):'
        : 'Reference examples from similar projects:';
    return {
      path: `(sibling examples in ${workspaceRoot})`,
      tier: 'sibling',
      content: `[No ${primaryName} found in this project.]\n\n## ${hint}\n${examples.join('\n\n')}`,
      rawContent: null,
      truncated: false,
    };
  }

  return null;
}

// ─── Tier 0: Shipped Defaults ──────────────────────────────────────────────────

/**
 * Resolve the path to the babel-cli/defaults/ directory containing shipped
 * identity files. Uses import.meta.url to find the path relative to the
 * compiled output (babel-cli/dist/interactive/identity.js → babel-cli/defaults/).
 */
function getBabelDefaultsDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Compiled output: dist/interactive/ → ../../defaults/
  return path.resolve(__dirname, '..', '..', 'defaults');
}

/**
 * Load an identity section from the shipped defaults directory.
 * Called after all 3 tiers (project-local, workspace-meta, sibling examples)
 * have returned nothing.
 */
function loadBabelDefaultIdentitySection(
  names: string[],
  maxChars: number,
): LoadedIdentitySection | null {
  try {
    const defaultsDir = getBabelDefaultsDir();
    if (!fs.existsSync(defaultsDir)) return null;

    for (const name of names) {
      const defaultPath = path.join(defaultsDir, name);
      if (fs.existsSync(defaultPath)) {
        const content = fs.readFileSync(defaultPath, 'utf-8');
        const trimmed = trimForPrompt(content, maxChars);
        const primaryName = names[0] ?? name;
        const prefixed = `*(Using Babel's shipped default — create a project-local ${primaryName} to override)*\n\n${trimmed}`;
        return {
          path: defaultPath,
          tier: 'shipped_default',
          content: prefixed,
          rawContent: content,
          truncated: content.length > maxChars,
        };
      }
    }
  } catch {
    // Non-fatal — defaults are a nice-to-have
  }
  return null;
}

/**
 * Resolve the delivered session identity together with a per-fragment
 * disposition (source path, tier, delivered digest, truncation). This is the
 * single reader behind `loadProjectSessionIdentity`; callers that build the
 * instruction manifest use the fragments so delivered identity files are
 * reported instead of silently omitted.
 */
export function loadProjectSessionIdentityDispositionSync(
  projectRoot: string,
  workspaceRoot?: string | null,
): SessionIdentityWithDisposition {
  const workspace = workspaceRoot ?? path.dirname(projectRoot);
  const fragments: IdentityDeliveredFragment[] = [];

  const add = (
    id: string,
    title: string,
    section: LoadedIdentitySection,
  ): void => {
    const delivered = title + '\n' + section.content;
    fragments.push({
      id,
      source: section.path,
      tier: section.tier,
      delivered_content: delivered,
      delivered_chars: delivered.length,
      delivered_content_digest: sha256Text(delivered),
      source_digest: section.rawContent === null ? null : sha256Text(section.rawContent),
      source_length: section.rawContent === null ? null : section.rawContent.length,
      truncated: section.truncated,
    });
  };

  // ── SOUL.md — critical identity (Tier 0: shipped defaults) ──
  const soulSection =
    loadIdentityFileSectionSync(projectRoot, workspace, ['SOUL.md', 'soul.md'], 1500) ??
    loadBabelDefaultIdentitySection(['SOUL.md', 'soul.md'], 1500);
  if (soulSection) add('session:soul', '# Agent Soul', soulSection);

  // ── AGENT_IDENTITY.md — critical identity (Tier 0: shipped defaults) ──
  const identitySection =
    loadIdentityFileSectionSync(
      projectRoot,
      workspace,
      ['AGENT_IDENTITY.md', 'agent_identity.md', '.agent-identity'],
      1500,
    ) ?? loadBabelDefaultIdentitySection(
      ['AGENT_IDENTITY.md', 'agent_identity.md', '.agent-identity'],
      1500,
    );
  if (identitySection) add('session:agent_identity', '# Agent Identity', identitySection);

  // ── AGENTS.md — agent instructions ──
  const agentSection = loadIdentityFileSectionSync(
    projectRoot,
    workspace,
    ['AGENTS.md', 'Agent.md'],
    3000,
  );
  if (agentSection) add('session:agents', '# Agent Instructions', agentSection);

  // ── CLAUDE.md — project instructions ──
  const claudeSection = loadIdentityFileSectionSync(
    projectRoot,
    workspace,
    ['CLAUDE.md'],
    3000,
  );
  if (claudeSection) add('session:claude', '# Project Instructions', claudeSection);

  // ── ENGINEERING.md — engineering standards (Tier 0: shipped defaults) ──
  const engSection =
    loadIdentityFileSectionSync(projectRoot, workspace, ['ENGINEERING.md'], 2500) ??
    loadBabelDefaultIdentitySection(['ENGINEERING.md'], 2500);
  if (engSection) add('session:engineering', '# Engineering Standards', engSection);

  // ── PROJECT_CONTEXT.md — project context ──
  const ctxSection = loadIdentityFileSectionSync(
    projectRoot,
    workspace,
    ['PROJECT_CONTEXT.md'],
    3000,
  );
  if (ctxSection) add('session:project_context', '# Project Context', ctxSection);

  try {
    const repoMap = loadCachedRepoMap(projectRoot);
    if (repoMap && repoMap.entries.length > 0) {
      const delivered = formatRepoMapPromptSection(repoMap, 40);
      fragments.push({
        id: 'session:repo_map',
        source: '(cached repo map)',
        tier: 'repo_map',
        delivered_content: delivered,
        delivered_chars: delivered.length,
        delivered_content_digest: sha256Text(delivered),
        source_digest: null,
        source_length: null,
        truncated: false,
      });
    }
  } catch {
    // Non-fatal
  }

  return {
    systemContext: fragments.map((fragment) => fragment.delivered_content).join('\n\n'),
    fragments,
  };
}

/**
 * Async facade kept for callers that prefer a promise and for the byte-identity
 * guard in `instructionDisposition.test.ts`. It delegates to the single sync
 * reader; it is not a second implementation.
 */
export async function loadProjectSessionIdentityWithDisposition(
  projectRoot: string,
  workspaceRoot?: string | null,
): Promise<SessionIdentityWithDisposition> {
  return loadProjectSessionIdentityDispositionSync(projectRoot, workspaceRoot);
}

export async function loadProjectSessionIdentity(
  projectRoot: string,
  workspaceRoot?: string | null,
): Promise<string> {
  return loadProjectSessionIdentityDispositionSync(projectRoot, workspaceRoot).systemContext;
}

export async function loadSessionIdentity(ctx: ReplContext, projectRoot: string): Promise<string> {
  if (ctx.sessionIdentity !== null && ctx.sessionIdentityRoot === projectRoot) {
    return ctx.sessionIdentity;
  }
  ctx.sessionIdentityRoot = projectRoot;
  ctx.sessionIdentity = await loadProjectSessionIdentity(projectRoot, ctx.lastWorkspaceRoot);
  return ctx.sessionIdentity;
}

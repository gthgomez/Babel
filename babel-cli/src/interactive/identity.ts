// ─── Identity Loading ─────────────────────────────────────────────────────────
// Extracted from interactive.ts — session identity file loading with the
// 4-tier fallback hierarchy: project-local → workspace-meta → sibling examples → shipped defaults.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCachedRepoMap } from '../services/indexer.js';
import { formatRepoMapPromptSection, trimForPrompt } from '../services/liteProjectContext.js';
import type { ReplContext } from './context.js';

export async function findSiblingExamples(
  searchRoot: string,
  ownRoot: string,
  names: string[],
  limit: number,
): Promise<string[]> {
  const results: string[] = [];
  try {
    if (!fs.existsSync(searchRoot)) return results;
    const entries = fs.readdirSync(searchRoot, { withFileTypes: true });
    let batchCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(searchRoot, entry.name);
      if (path.resolve(dirPath) === path.resolve(ownRoot)) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      if (++batchCount >= 30) {
        batchCount = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }

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

export async function loadIdentityFile(
  projectRoot: string,
  workspaceRoot: string,
  names: string[],
  title: string,
  maxChars: number,
  findSiblings: (
    searchRoot: string,
    ownRoot: string,
    names: string[],
    limit: number,
  ) => Promise<string[]>,
): Promise<[string, string] | null> {
  // Tier 1: Project-local
  for (const name of names) {
    const localPath = path.join(projectRoot, name);
    if (fs.existsSync(localPath)) {
      try {
        return [title, trimForPrompt(fs.readFileSync(localPath, 'utf-8'), maxChars)];
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
          const metaContent = trimForPrompt(fs.readFileSync(metaPath, 'utf-8'), 2500);
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
          return [title, adversarial];
        } catch {
          continue;
        }
      }
    }
  }

  // Tier 3: Sibling examples
  const primaryName = names[0] ?? 'this file';
  const examples = await findSiblings(workspaceRoot, projectRoot, names, 3);
  if (examples.length > 0) {
    const hint =
      primaryName === 'ENGINEERING.md'
        ? 'Reference examples from similar projects (use these patterns to suggest one):'
        : 'Reference examples from similar projects:';
    return [
      title,
      `[No ${primaryName} found in this project.]\n\n## ${hint}\n${examples.join('\n\n')}`,
    ];
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
function loadBabelDefaultIdentityFile(
  names: string[],
  title: string,
  maxChars: number,
): [string, string] | null {
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
        return [title, prefixed];
      }
    }
  } catch {
    // Non-fatal — defaults are a nice-to-have
  }
  return null;
}

export async function loadProjectSessionIdentity(
  projectRoot: string,
  workspaceRoot?: string | null,
): Promise<string> {
  const sections: string[] = [];
  const workspace = workspaceRoot ?? path.dirname(projectRoot);

  // ── SOUL.md — critical identity (Tier 0: shipped defaults) ──
  const soulSection =
    (await loadIdentityFile(
      projectRoot,
      workspace,
      ['SOUL.md', 'soul.md'],
      '# Agent Soul',
      1500,
      findSiblingExamples,
    )) ??
    loadBabelDefaultIdentityFile(['SOUL.md', 'soul.md'], '# Agent Soul', 1500);
  if (soulSection) sections.push(soulSection[0] + '\n' + soulSection[1]);

  // ── AGENT_IDENTITY.md — critical identity (Tier 0: shipped defaults) ──
  const identitySection =
    (await loadIdentityFile(
      projectRoot,
      workspace,
      ['AGENT_IDENTITY.md', 'agent_identity.md', '.agent-identity'],
      '# Agent Identity',
      1500,
      findSiblingExamples,
    )) ??
    loadBabelDefaultIdentityFile(
      ['AGENT_IDENTITY.md', 'agent_identity.md', '.agent-identity'],
      '# Agent Identity',
      1500,
    );
  if (identitySection) sections.push(identitySection[0] + '\n' + identitySection[1]);

  // ── AGENTS.md — agent instructions ──
  const agentSection = await loadIdentityFile(
    projectRoot,
    workspace,
    ['AGENTS.md', 'Agent.md'],
    '# Agent Instructions',
    3000,
    findSiblingExamples,
  );
  if (agentSection) sections.push(agentSection[0] + '\n' + agentSection[1]);

  // ── CLAUDE.md — project instructions ──
  const claudeSection = await loadIdentityFile(
    projectRoot,
    workspace,
    ['CLAUDE.md'],
    '# Project Instructions',
    3000,
    findSiblingExamples,
  );
  if (claudeSection) sections.push(claudeSection[0] + '\n' + claudeSection[1]);

  // ── ENGINEERING.md — engineering standards (Tier 0: shipped defaults) ──
  const engSection =
    (await loadIdentityFile(
      projectRoot,
      workspace,
      ['ENGINEERING.md'],
      '# Engineering Standards',
      2500,
      findSiblingExamples,
    )) ??
    loadBabelDefaultIdentityFile(['ENGINEERING.md'], '# Engineering Standards', 2500);
  if (engSection) sections.push(engSection[0] + '\n' + engSection[1]);

  // ── PROJECT_CONTEXT.md — project context ──
  const ctxSection = await loadIdentityFile(
    projectRoot,
    workspace,
    ['PROJECT_CONTEXT.md'],
    '# Project Context',
    3000,
    findSiblingExamples,
  );
  if (ctxSection) sections.push(ctxSection[0] + '\n' + ctxSection[1]);

  try {
    const repoMap = loadCachedRepoMap(projectRoot);
    if (repoMap && repoMap.entries.length > 0) {
      sections.push(formatRepoMapPromptSection(repoMap, 40));
    }
  } catch {
    // Non-fatal
  }

  return sections.join('\n\n');
}

export async function loadSessionIdentity(ctx: ReplContext, projectRoot: string): Promise<string> {
  if (ctx.sessionIdentity !== null && ctx.sessionIdentityRoot === projectRoot) {
    return ctx.sessionIdentity;
  }
  ctx.sessionIdentityRoot = projectRoot;
  ctx.sessionIdentity = await loadProjectSessionIdentity(projectRoot, ctx.lastWorkspaceRoot);
  return ctx.sessionIdentity;
}

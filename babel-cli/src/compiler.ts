/**
 * compiler.ts — Babel Context Compiler and Typed Stack Resolver
 *
 * Reads and concatenates the Markdown prompt files listed in an Orchestrator
 * manifest, then appends the user's raw task at the end. It also resolves
 * v9 typed instruction stacks against `prompt_catalog.yaml` into a compiled
 * prompt manifest that remains backward compatible with legacy consumers.
 *
 * Runtime path:
 *   - `compileContext()` is async and parallelized for the live pipeline.
 *   - A persistent per-file content cache keeps warm-start compiles fast.
 * Audit / offline tooling path:
 *   - `compileContextSync()` preserves a simple synchronous API where speed
 *     is less important than portability.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OrchestratorManifest } from './schemas/agentContracts.js';
import { resolveInstructionStackManifest as resolveInstructionStackManifestInternal } from './control-plane/stackResolver.js';
import {
  buildUntrustedContentBlock,
  untrustedContentInstruction,
} from './utils/untrustedContent.js';

const FILE_BOUNDARY_OPEN = (name: string) => `\n\n--- START OF FILE: ${name} ---\n\n`;
const FILE_BOUNDARY_CLOSE = (name: string) => `\n\n--- END OF FILE: ${name} ---`;
const TASK_BOUNDARY = '\n\n--- TASK CONTEXT ---\n\n';
const COMPILER_CACHE_VERSION = 1;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function compressSkillCatalogContent(content: string): string {
  const rawLines = content.split(/\r?\n/);
  const compressedLines = [
    '# COMPRESSED SKILL CATALOG',
    '# Use load_skill_manifest(skill_id) to retrieve the complete guidelines for a specific skill.',
    'skills:'
  ];
  let currentId: string | null = null;
  let currentTags: string | null = null;

  for (const line of rawLines) {
    const idMatch = line.match(/^\s*-\s+id:\s*([a-zA-Z0-9_]+)/);
    if (idMatch) {
      if (currentId) {
        compressedLines.push(`  - id: ${currentId}`);
        if (currentTags) compressedLines.push(`    tags: ${currentTags}`);
      }
      currentId = idMatch[1]!;
      currentTags = null;
      continue;
    }
    const tagsMatch = line.match(/^\s+tags:\s*(\[.*\])/);
    if (tagsMatch && currentId) {
      currentTags = tagsMatch[1]!;
    }
  }
  if (currentId) {
    compressedLines.push(`  - id: ${currentId}`);
    if (currentTags) compressedLines.push(`    tags: ${currentTags}`);
  }
  return compressedLines.join('\n');
}

interface CachedContextFile {
  mtimeMs: number;
  size: number;
  sha256: string;
  content: string;
}

interface CompilerCacheDocument {
  version: number;
  files: Record<string, CachedContextFile>;
}

interface CompilerCacheState {
  path: string;
  document: CompilerCacheDocument;
}

let compilerCacheState: CompilerCacheState | null = null;

function getCompilerCachePath(): string {
  const override = process.env['BABEL_CONTEXT_CACHE_PATH']?.trim();
  if (override) {
    return resolve(override);
  }

  return resolve(__dirname, '..', '.cache', 'compiler-context-cache.json');
}

function createEmptyCompilerCache(): CompilerCacheDocument {
  return {
    version: COMPILER_CACHE_VERSION,
    files: {},
  };
}

async function loadCompilerCache(): Promise<CompilerCacheState> {
  const cachePath = getCompilerCachePath();
  if (compilerCacheState?.path === cachePath) {
    return compilerCacheState;
  }

  let document = createEmptyCompilerCache();
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CompilerCacheDocument>;
    if (
      parsed.version === COMPILER_CACHE_VERSION &&
      parsed.files &&
      typeof parsed.files === 'object'
    ) {
      document = {
        version: COMPILER_CACHE_VERSION,
        files: parsed.files as Record<string, CachedContextFile>,
      };
    }
  } catch {
    document = createEmptyCompilerCache();
  }

  compilerCacheState = {
    path: cachePath,
    document,
  };
  return compilerCacheState;
}

async function saveCompilerCache(state: CompilerCacheState): Promise<void> {
  try {
    await mkdir(dirname(state.path), { recursive: true });
    await writeFile(state.path, `${JSON.stringify(state.document, null, 2)}\n`, 'utf-8');
  } catch {
    // Cache writes are best-effort. Compile correctness must not depend on them.
  }
}

async function loadCachedFileContent(filePath: string, state: CompilerCacheState): Promise<string> {
  const absolutePath = resolve(filePath);
  const fileStats = await stat(absolutePath);
  const cached = state.document.files[absolutePath];

  if (cached && cached.mtimeMs === fileStats.mtimeMs && cached.size === fileStats.size) {
    return cached.content;
  }

  const rawContent = await readFile(absolutePath, 'utf-8');
  const content = rawContent.trimEnd();
  state.document.files[absolutePath] = {
    mtimeMs: fileStats.mtimeMs,
    size: fileStats.size,
    sha256: createHash('sha256').update(rawContent, 'utf8').digest('hex'),
    content,
  };

  return content;
}

async function maybeLoadProjectMemories(projectRoot?: string): Promise<string | null> {
  if (!projectRoot) {
    return null;
  }

  const memoryPath = join(projectRoot, '.babel', 'project_memories.md');
  if (!existsSync(memoryPath)) {
    return null;
  }

  const cacheState = await loadCompilerCache();
  const content = await loadCachedFileContent(memoryPath, cacheState);
  await saveCompilerCache(cacheState);
  return content.trim();
}

function buildCompiledContext(
  manifestEntries: Array<{ filePath: string; content: string }>,
  taskContext: string,
  projectMemories?: string | null,
): string {
  const parts: string[] = [];

  for (const entry of manifestEntries) {
    const name = basename(entry.filePath);
    parts.push(FILE_BOUNDARY_OPEN(name) + entry.content + FILE_BOUNDARY_CLOSE(name));
  }

  if (projectMemories && projectMemories.length > 0) {
    parts.push(
      '\n' +
        untrustedContentInstruction('PROJECT_MEMORIES') +
        '\n' +
        buildUntrustedContentBlock('PROJECT_MEMORIES', projectMemories) +
        '\n',
    );
  }

  parts.push(TASK_BOUNDARY + taskContext.trim() + '\n');
  return parts.join('');
}

function validateCompileContextInputs(manifestPaths: string[], taskContext: string): void {
  if (manifestPaths.length === 0) {
    throw new Error('[compiler] manifestPaths must not be empty.');
  }
  if (!taskContext.trim()) {
    throw new Error('[compiler] taskContext must not be blank.');
  }
}

export function clearCompilerCacheForTests(): void {
  compilerCacheState = null;
}

/**
 * Compiles an ordered list of Markdown prompt files plus a raw task description
 * into a single context string suitable for LLM submission.
 *
 * @param manifestPaths - Ordered array of .md file paths (absolute or CWD-relative).
 *                        Files are read in the order given; order must match the
 *                        `load_order` values from the OrchestratorManifest.
 * @param taskContext   - The user's raw task string, injected at the very end so
 *                        the model reads layered instructions before the request.
 * @returns A single compiled string ready to be sent to a ClaudeCliRunner or
 *          ApiFallbackRunner.
 * @throws  {Error} If `manifestPaths` is empty, or if any file cannot be read.
 */
export async function compileContext(
  manifestPaths: string[],
  taskContext: string,
  projectRoot?: string,
  stubs?: Map<string, string>,
): Promise<string> {
  validateCompileContextInputs(manifestPaths, taskContext);

  const cacheState = await loadCompilerCache();
  const manifestEntries = await Promise.all(
    manifestPaths.map(async (filePath) => {
      const stub = stubs?.get(filePath);
      if (stub) {
        return {
          filePath,
          content: `[STUBBED] ${stub}\n(File not loaded to save tokens. Use file_read to expand if implementation details are required.)`,
        };
      }

      // Compress Skill-Catalog if it matches to preserve JIT loading
      if (filePath.endsWith('Skill-Catalog.yaml') || filePath.includes('Skill-Catalog.yaml')) {
        try {
          const content = await loadCachedFileContent(filePath, cacheState);
          return {
            filePath,
            content: compressSkillCatalogContent(content),
          };
        } catch {
          // fallback
        }
      }

      // P4 token optimization: lazy-load large skill files (>6 KB).
      const LAZY_STUB_THRESHOLD_BYTES = 8_000;
      if (filePath.includes('/02_Skills/') || filePath.includes('\\.compiled\\')) {
        try {
          const stat = statSync(filePath);
          if (stat.size > LAZY_STUB_THRESHOLD_BYTES) {
            const fileName =
              filePath
                .split(/[/\\]/)
                .pop()
                ?.replace(/\.(min\.)?md$/, '') ?? 'skill';
            return {
              filePath,
              content:
                `[LAZY-STUBBED] Skill "${fileName}" is available but not preloaded to save tokens.\n` +
                `Use file_read to load the full skill content before applying its specialized guidance.`,
            };
          }
        } catch {
          // File doesn't exist — fall through to normal loading
        }
      }

      return {
        filePath,
        content: await loadCachedFileContent(filePath, cacheState),
      };
    }),
  );

  // Project boundary warnings (Item 3c): log when manifest files live outside the target project root
  if (projectRoot) {
    const normalizedProjectRoot =
      resolve(projectRoot) + (process.platform === 'win32' ? '\\' : '/');
    let outsideCount = 0;
    for (const entry of manifestEntries) {
      const resolved = resolve(entry.filePath) + (process.platform === 'win32' ? '\\' : '/');
      if (!resolved.startsWith(normalizedProjectRoot)) {
        outsideCount++;
      }
    }
    if (outsideCount > 0) {
      console.warn(
        `[compiler] ${outsideCount} / ${manifestEntries.length} manifest path(s) are outside project root ` +
          `"${projectRoot}". These files consume context budget without being project-specific. ` +
          `Use --budget to control the token budget limit.`,
      );
    }
  }

  const projectMemories = await maybeLoadProjectMemories(projectRoot);
  await saveCompilerCache(cacheState);

  return buildCompiledContext(manifestEntries, taskContext, projectMemories);
}

export function compileContextSync(
  manifestPaths: string[],
  taskContext: string,
  projectRoot?: string,
  stubs?: Map<string, string>,
): string {
  validateCompileContextInputs(manifestPaths, taskContext);

  const manifestEntries = manifestPaths.map((filePath) => {
    const stub = stubs?.get(filePath);
    if (stub) {
      return {
        filePath,
        content: `[STUBBED] ${stub}\n(File not loaded to save tokens. Use file_read to expand if implementation details are required.)`,
      };
    }

    // Compress Skill-Catalog if it matches to preserve JIT loading
    if (filePath.endsWith('Skill-Catalog.yaml') || filePath.includes('Skill-Catalog.yaml')) {
      try {
        const content = readFileSync(filePath, 'utf-8').trimEnd();
        return {
          filePath,
          content: compressSkillCatalogContent(content),
        };
      } catch {
        // fallback
      }
    }

    // P4 token optimization: lazy-load large skill files.
    // Skills over 6 KB (~1,500 tokens) are automatically stubbed with a
    // one-line description. The model can use file_read to expand them on demand.
    // Small skills and non-skill files (Behavioral OS, Domain, Adapters, Pipeline)
    // are always loaded fully — they're essential for correct behavior.
    const LAZY_STUB_THRESHOLD_BYTES = 6_000;
    if (filePath.includes('/02_Skills/') || filePath.includes('\\.compiled\\')) {
      try {
        const stat = statSync(filePath);
        if (stat.size > LAZY_STUB_THRESHOLD_BYTES) {
          const fileName =
            filePath
              .split(/[/\\]/)
              .pop()
              ?.replace(/\.(min\.)?md$/, '') ?? 'skill';
          return {
            filePath,
            content:
              `[LAZY-STUBBED] Skill "${fileName}" is available but not preloaded to save tokens.\n` +
              `Use file_read to load the full skill content before applying its specialized guidance.`,
          };
        }
      } catch {
        // File doesn't exist or can't be stat'd — fall through to normal loading
      }
    }

    const content = readFileSync(filePath, 'utf-8').trimEnd();
    return { filePath, content };
  });

  // Project boundary warnings (Item 3c): log when manifest files live outside the target project root
  if (projectRoot) {
    const normalizedProjectRoot =
      resolve(projectRoot) + (process.platform === 'win32' ? '\\' : '/');
    let outsideCount = 0;
    for (const entry of manifestEntries) {
      const resolved = resolve(entry.filePath) + (process.platform === 'win32' ? '\\' : '/');
      if (!resolved.startsWith(normalizedProjectRoot)) {
        outsideCount++;
      }
    }
    if (outsideCount > 0) {
      console.warn(
        `[compiler] ${outsideCount} / ${manifestEntries.length} manifest path(s) are outside project root ` +
          `"${projectRoot}". These files consume context budget without being project-specific. ` +
          `Use --budget to control the token budget limit.`,
      );
    }
  }

  let projectMemories: string | null = null;
  if (projectRoot) {
    const memoryPath = join(projectRoot, '.babel', 'project_memories.md');
    if (existsSync(memoryPath)) {
      projectMemories = readFileSync(memoryPath, 'utf-8').trim();
    }
  }

  return buildCompiledContext(manifestEntries, taskContext, projectMemories);
}
export function resolveInstructionStackManifest(
  manifest: OrchestratorManifest,
  babelRoot: string,
): OrchestratorManifest {
  return resolveInstructionStackManifestInternal(manifest, babelRoot);
}

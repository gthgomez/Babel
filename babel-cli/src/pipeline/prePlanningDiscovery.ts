/**
 * prePlanningDiscovery.ts — Read-only project exploration before SWE planning
 *
 * Before the planner generates an implementation plan, this module performs
 * a read-only discovery pass of the project root. The results are injected
 * into the planning prompt as structured context, enabling the planner to
 * make data-driven decisions about file paths, existing code, and project
 * structure — instead of guessing from task text alone.
 *
 * Architecture:
 *   1. Scan project root (directory_list, limited depth)
 *   2. Read key files (package.json, tsconfig, source files if manageable)
 *   3. Build a structured inventory
 *   4. Inject into planning prompt as "Gathered Discovery Context"
 */

import { existsSync, lstatSync, opendirSync, realpathSync, statSync, type Dir, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isCredentialTargetPath } from '../authority/protectedPath.js';
import { checkedFileBytes } from '../utils/checkedFileRead.js';
import { acquireEffectDirectoryAnchors, type EffectDirectoryAnchors } from '../executor/effectDirectoryAnchors.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveryFileEntry {
  path: string;
  sizeBytes: number;
  /** First ~500 chars if a text file, null if binary or too large */
  preview: string | null;
}

export interface DiscoveryInventory {
  projectRoot: string;
  /** Top-level directory listing (depth 1-2) */
  fileTree: string[];
  /** Key config files found */
  configFiles: Record<string, string | null>;
  /** Source files discovered (up to 50) */
  sourceFiles: DiscoveryFileEntry[];
  /** Total files discovered */
  totalFiles: number;
  truncated?: boolean;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_DISCOVERY_FILES = 100;
const MAX_DISCOVERY_ENTRIES = MAX_DISCOVERY_FILES * 4;
const MAX_SOURCE_FILES = 50;
const MAX_FILE_PREVIEW_BYTES = 500;
const MAX_FILE_READ_BYTES = 50_000;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  'runs',
  '__pycache__',
  '.venv',
  '.idea',
  '.vscode',
  'vendor',
  '.godot',
]);
const TEXT_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|yaml|yml|css|html|py|rb|go|rs|java|kt|sh|ps1|xml|sql|toml|ini|cfg|env\.example)$/i;
const KEY_CONFIG_FILES = [
  'package.json',
  'tsconfig.json',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Makefile',
  'Dockerfile',
  '.env.example',
  'README.md',
];

// ─── Implementation ───────────────────────────────────────────────────────────

export function protectedDiscoveryPath(value: string): boolean {
  return isCredentialTargetPath(value) || /(?:^|[/\\])\.(?:env(?:\.|$)|git(?:[/\\]|$)|codex(?:[/\\]|$))/i.test(value);
}

function readDiscoveryFile(root: string, path: string, anchors: EffectDirectoryAnchors): { content: string | null; size: number } | null {
  try {
    if (protectedDiscoveryPath(path)) return null;
    const physicalRoot = realpathSync(root);
    const physical = realpathSync(path);
    const rel = relative(physicalRoot, physical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || protectedDiscoveryPath(physical)) return null;
    const accessPath = anchors.path(path);
    const stat = lstatSync(accessPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return null;
    if (stat.size > BigInt(MAX_FILE_READ_BYTES)) return { content: null, size: Number(stat.size) };
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const bytes = checkedFileBytes(accessPath, MAX_FILE_READ_BYTES, () => {
      anchors.path(path);
      return normalize(realpathSync(root)) === normalize(physicalRoot) && normalize(realpathSync(path)) === normalize(physical);
    }, undefined, stat);
    return bytes ? { content: bytes.toString('utf8'), size: Number(stat.size) } : null;
  } catch { return null; }
}

function readConfigFiles(projectRoot: string, anchors: EffectDirectoryAnchors): Record<string, string | null> {
  const configs: Record<string, string | null> = {};
  for (const configFile of KEY_CONFIG_FILES) {
    const configPath = join(projectRoot, configFile);
    if (existsSync(configPath)) {
      try {
        const content = readDiscoveryFile(projectRoot, configPath, anchors);
        configs[configFile] = content?.content?.slice(0, 2000) ?? null;
      } catch {
        configs[configFile] = null;
      }
    }
  }
  return configs;
}

function discoverSourceFiles(projectRoot: string, fileTree: string[], anchors: EffectDirectoryAnchors): DiscoveryFileEntry[] {
  const sourceFiles: DiscoveryFileEntry[] = [];
  for (const filePath of fileTree) {
    if (sourceFiles.length >= MAX_SOURCE_FILES) break;
    if (filePath.endsWith('/')) continue;
    if (!TEXT_EXTENSIONS.test(filePath)) continue;

    const fullPath = join(projectRoot, filePath);
    try {
      const file = readDiscoveryFile(projectRoot, fullPath, anchors);
      if (!file) continue;
      sourceFiles.push({
        path: filePath,
        sizeBytes: file.size,
        preview: file.content?.slice(0, MAX_FILE_PREVIEW_BYTES) ?? null,
      });
    } catch {
      // Skip inaccessible files
    }
  }
  return sourceFiles;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function discoverProject(projectRoot: string): DiscoveryInventory | null {
  void projectRoot;
  throw new Error('Synchronous discovery is unavailable; use discoverProjectGuarded.');
}

/** Build a bounded inventory while retaining directory identity across enumeration. */
export async function discoverProjectGuarded(projectRoot: string, signal?: AbortSignal): Promise<DiscoveryInventory | null> {
  if (!projectRoot || !existsSync(projectRoot)) return null;
  signal?.throwIfAborted();
  const resolvedRoot = realpathSync(resolve(projectRoot));
  const rootIdentity = lstatSync(resolvedRoot, { bigint: true });
  let pending: Array<{ path: string; prefix: string; expected: BigIntStats }> = [{ path: resolvedRoot, prefix: '', expected: rootIdentity }];
  const fileTree: string[] = [];
  let entriesSeen = 0;
  let truncated = false;
  for (let depth = 0; depth <= 2 && pending.length && fileTree.length < MAX_DISCOVERY_FILES && entriesSeen < MAX_DISCOVERY_ENTRIES; depth++) {
    const current = pending; pending = [];
    const anchors = await acquireEffectDirectoryAnchors(current.map(item => item.path));
    try {
      signal?.throwIfAborted();
      for (const item of current) {
        if (fileTree.length >= MAX_DISCOVERY_FILES) break;
        const pinned = dirname(anchors.path(join(item.path, '__babel_discovery_anchor__')));
        const actual = statSync(pinned, { bigint: true });
        if (!actual.isDirectory() || actual.dev !== item.expected.dev || actual.ino !== item.expected.ino) continue;
        let directory: Dir;
        try { directory = opendirSync(pinned); } catch { truncated = true; continue; }
        try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (fileTree.length >= MAX_DISCOVERY_FILES || entriesSeen >= MAX_DISCOVERY_ENTRIES) { truncated = true; break; }
          entriesSeen++;
          if (SKIP_DIRS.has(entry.name)) continue;
          const relPath = item.prefix ? `${item.prefix}/${entry.name}` : entry.name;
          if (protectedDiscoveryPath(relPath)) continue;
          if (entry.isDirectory()) {
            const childStat = lstatSync(join(pinned, entry.name), { bigint: true });
            if (!childStat.isDirectory() || childStat.isSymbolicLink()) continue;
            fileTree.push(`${relPath}/`);
            if (depth < 2) pending.push({ path: join(item.path, entry.name), prefix: relPath, expected: childStat });
          } else if (entry.isFile()) fileTree.push(relPath);
        } } finally { directory.closeSync(); }
        await new Promise<void>(resolveYield => setImmediate(resolveYield));
        signal?.throwIfAborted();
        anchors.path(join(item.path, '__babel_discovery_anchor__'));
      }
      signal?.throwIfAborted();
    } finally { await anchors.release(); }
    signal?.throwIfAborted();
  }
  if (pending.length || fileTree.length >= MAX_DISCOVERY_FILES || entriesSeen >= MAX_DISCOVERY_ENTRIES) truncated = true;
  const previewPaths = fileTree.filter(path => !path.endsWith('/') && TEXT_EXTENSIONS.test(path));
  const parents = [...new Set([resolvedRoot, ...previewPaths.map(path => dirname(join(resolvedRoot, path)))])];
  const expectedParents = new Map<string, BigIntStats>();
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  for (const parent of parents) {
    const stat = lstatSync(parent, { bigint: true });
    const rel = relative(resolvedRoot, parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (parent === resolvedRoot && (stat.dev !== rootIdentity.dev || stat.ino !== rootIdentity.ino)) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || normalize(realpathSync(parent)) !== normalize(parent)) {
      throw new Error('Discovery preview directory is outside its physical boundary.');
    }
    expectedParents.set(parent, stat);
  }
  const previewAnchors = await acquireEffectDirectoryAnchors(parents);
  try {
    signal?.throwIfAborted();
    for (const parent of parents) {
      const pinned = dirname(previewAnchors.path(join(parent, '__babel_preview_anchor__')));
      const actual = statSync(pinned, { bigint: true }); const expected = expectedParents.get(parent)!;
      if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino || normalize(realpathSync(parent)) !== normalize(parent)) {
        throw new Error('Discovery preview directory changed before it was held.');
      }
    }
    const configFiles = readConfigFiles(resolvedRoot, previewAnchors);
    const sourceFiles = discoverSourceFiles(resolvedRoot, fileTree, previewAnchors);
    await new Promise<void>(resolveYield => setImmediate(resolveYield));
    signal?.throwIfAborted();
    for (const parent of parents) previewAnchors.path(join(parent, '__babel_preview_anchor__'));
    return { projectRoot: resolvedRoot, fileTree, configFiles, sourceFiles, totalFiles: fileTree.filter(path => !path.endsWith('/')).length, truncated };
  } finally { await previewAnchors.release(); }
}

/**
 * Format the discovery inventory as prompt lines for injection into the
 * planning context. This gives the planner concrete file paths and
 * project structure without requiring a separate API call.
 */
export function formatDiscoveryForPlanner(inventory: DiscoveryInventory): string[] {
  const lines: string[] = [
    '',
    '--- PRE-PLANNING PROJECT DISCOVERY ---',
    `Project root: ${inventory.projectRoot}`,
    `Total files discovered: ${inventory.totalFiles}`,
    '',
  ];
  if (inventory.truncated) lines.push('Discovery was bounded; use directory_list for additional entries.', '');

  // Config files summary
  const foundConfigs = Object.entries(inventory.configFiles).filter(([, v]) => v !== undefined);
  if (foundConfigs.length > 0) {
    lines.push('Key configuration files found:');
    for (const [name, content] of foundConfigs) {
      if (content) {
        // Show first line to identify the config
        const firstLine = content.split('\n')[0]?.trim() ?? '';
        lines.push(`  - ${name}: ${firstLine.slice(0, 120)}`);
      } else {
        lines.push(`  - ${name}: (present but unreadable)`);
      }
    }
    lines.push('');
  }

  // File tree (limited)
  lines.push('Project file tree (depth 2, top ${inventory.fileTree.length} entries):');
  for (const entry of inventory.fileTree.slice(0, 40)) {
    lines.push(`  ${entry}`);
  }
  if (inventory.fileTree.length > 40) {
    lines.push(`  ... and ${inventory.fileTree.length - 40} more entries`);
  }
  lines.push('');

  // Source file previews (limited)
  if (inventory.sourceFiles.length > 0) {
    lines.push('Key source files (up to 10 with previews):');
    for (const sourceFile of inventory.sourceFiles.slice(0, 10)) {
      const sizeKB = (sourceFile.sizeBytes / 1024).toFixed(1);
      lines.push(`  ${sourceFile.path} (${sizeKB} KB)`);
      if (sourceFile.preview) {
        // Show first few non-empty lines of the preview
        const previewLines = sourceFile.preview
          .split('\n')
          .filter((l) => l.trim())
          .slice(0, 3);
        for (const previewLine of previewLines) {
          lines.push(`    | ${previewLine.slice(0, 100)}`);
        }
      }
    }
    lines.push('');
  }

  lines.push(
    'Use these discovered files and paths in your plan. Prefer exact paths from this inventory.',
  );
  lines.push('Do not invent file names that are not listed above.');
  lines.push('');

  return lines;
}

/** Legacy synchronous entry point; callers must migrate to guarded discovery. */
export function getDiscoverySummary(projectRoot: string): string | null {
  const inventory = discoverProject(projectRoot);
  if (!inventory || inventory.totalFiles === 0) {
    return null;
  }
  return formatDiscoveryForPlanner(inventory).join('\n');
}

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

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

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
}

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_DISCOVERY_FILES = 100;
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

function listFiles(root: string, depth: number, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (dir: string, currentDepth: number, prefix: string): void => {
    if (files.length >= maxFiles || currentDepth > depth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(`${relPath}/`);
        if (currentDepth < depth) {
          visit(join(dir, entry.name), currentDepth + 1, relPath);
        }
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  };
  visit(root, 0, '');
  return files;
}

function readConfigFiles(projectRoot: string): Record<string, string | null> {
  const configs: Record<string, string | null> = {};
  for (const configFile of KEY_CONFIG_FILES) {
    const configPath = join(projectRoot, configFile);
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf-8');
        configs[configFile] = content.slice(0, 2000);
      } catch {
        configs[configFile] = null;
      }
    }
  }
  return configs;
}

function discoverSourceFiles(projectRoot: string, fileTree: string[]): DiscoveryFileEntry[] {
  const sourceFiles: DiscoveryFileEntry[] = [];
  for (const filePath of fileTree) {
    if (sourceFiles.length >= MAX_SOURCE_FILES) break;
    if (filePath.endsWith('/')) continue;
    if (!TEXT_EXTENSIONS.test(filePath)) continue;

    const fullPath = join(projectRoot, filePath);
    try {
      const stats = statSync(fullPath);
      if (stats.size > MAX_FILE_READ_BYTES) {
        sourceFiles.push({ path: filePath, sizeBytes: stats.size, preview: null });
        continue;
      }
      const content = readFileSync(fullPath, 'utf-8');
      sourceFiles.push({
        path: filePath,
        sizeBytes: stats.size,
        preview: content.slice(0, MAX_FILE_PREVIEW_BYTES),
      });
    } catch {
      // Skip inaccessible files
    }
  }
  return sourceFiles;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function discoverProject(projectRoot: string): DiscoveryInventory | null {
  if (!projectRoot || !existsSync(projectRoot)) {
    return null;
  }

  const resolvedRoot = resolve(projectRoot);
  const fileTree = listFiles(resolvedRoot, 2, MAX_DISCOVERY_FILES);
  const configFiles = readConfigFiles(resolvedRoot);
  const sourceFiles = discoverSourceFiles(resolvedRoot, fileTree);

  return {
    projectRoot: resolvedRoot,
    fileTree,
    configFiles,
    sourceFiles,
    totalFiles: fileTree.filter((f) => !f.endsWith('/')).length,
  };
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

/**
 * Get a lightweight inventory summary for the orchestrator/planning context.
 * Returns null if the project root doesn't exist or is empty.
 */
export function getDiscoverySummary(projectRoot: string): string | null {
  const inventory = discoverProject(projectRoot);
  if (!inventory || inventory.totalFiles === 0) {
    return null;
  }
  return formatDiscoveryForPlanner(inventory).join('\n');
}

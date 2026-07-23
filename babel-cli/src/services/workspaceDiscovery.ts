import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceProject {
  /** Canonical project name (directory basename) */
  name: string;
  /** Absolute path to the project root */
  root: string;
  /** Parent grouping directory name (e.g. "Project_SaaS"), if nested under one */
  family?: string;
  /** Which markers were found at the project root */
  markers: string[];
}

export interface WorkspaceContext {
  /** The resolved workspace root (dirname of BABEL_ROOT) */
  workspaceRoot: string;
  /** The detected project for the current directory, or null */
  project: WorkspaceProject | null;
  /** Cascading context files from workspace root down to project root */
  contextFiles: string[];
  /** Whether the resolved root appears to be a monorepo */
  monorepo: boolean;
  /** Sibling projects found in the workspace */
  siblingProjects: WorkspaceProject[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Files/directories that signal "this is a project root" */
const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'CLAUDE.md',
  'AGENTS.md',
  'PROJECT_CONTEXT.md',
  'prompt_catalog.yaml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'project.godot',
  'vite.config.ts',
  'next.config.js',
];

/** Context files collected in cascading order (workspace root → project root) */
const CASCADING_CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md'];

/** Directories under the workspace root that may contain projects */
const FAMILY_DIRECTORIES = ['Project_SaaS', 'example_mobile_suite', 'example_game_suite'];

/** Known project name aliases (directory basename → canonical name) */
const PROJECT_NAME_ALIASES: Record<string, string> = {
  simlife: 'SimLife',
  godot_td: 'TowerDefenseGodot',
  aetherlyn: 'AetherlynGameDraft',
  app_test_babel: 'App-test-Babel',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasProjectMarker(dir: string): boolean {
  try {
    return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
  } catch {
    return false;
  }
}

function getProjectMarkers(dir: string): string[] {
  try {
    return PROJECT_MARKERS.filter((marker) => existsSync(join(dir, marker)));
  } catch {
    return [];
  }
}

function parentOf(path: string): string {
  const parent = dirname(path);
  return parent === path ? path : parent;
}

function safeStat(path: string): import('node:fs').Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function normalizeProjectName(name: string): string {
  return name.trim();
}

function resolveCanonicalName(dirName: string): string {
  // Check aliases first (case-insensitive)
  for (const [alias, canonical] of Object.entries(PROJECT_NAME_ALIASES)) {
    if (alias.toLowerCase() === dirName.toLowerCase()) {
      return canonical;
    }
  }
  return dirName;
}

/**
 * Check if child is inside parent (both resolved).
 */
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.includes('..'));
}

// ─── WorkspaceScanner ─────────────────────────────────────────────────────────

export class WorkspaceScanner {
  private workspaceRoot: string;
  private familyRoots: string[];
  private projectCache: Map<string, WorkspaceProject | null> = new Map();
  private scanCache: WorkspaceProject[] | null = null;

  /**
   * @param workspaceRoot - The workspace root (typically dirname(BABEL_ROOT))
   */
  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.familyRoots = [];
    for (const family of FAMILY_DIRECTORIES) {
      const familyPath = join(this.workspaceRoot, family);
      const st = safeStat(familyPath);
      if (st !== null && st.isDirectory()) {
        this.familyRoots.push(familyPath);
      }
    }
  }

  /**
   * Factory: create a scanner from BABEL_ROOT.
   */
  static fromBabelRoot(babelRoot: string): WorkspaceScanner {
    return new WorkspaceScanner(dirname(babelRoot));
  }

  // ── Project detection ─────────────────────────────────────────────────────

  /**
   * Walk up from `cwd` looking for a directory with project markers.
   * Returns the first match, or null if none found (including when we reach workspace root).
   */
  detectFromCwd(cwd?: string): WorkspaceProject | null {
    const startDir = resolve(cwd ?? process.cwd());

    // Check cache
    const cached = this.projectCache.get(startDir);
    if (cached !== undefined) return cached;

    let current = startDir;

    // If startDir is a file, start from its parent
    const st = safeStat(current);
    if (st !== null && !st.isDirectory()) {
      current = dirname(current);
    }

    while (true) {
      if (hasProjectMarker(current)) {
        const project = this.buildProjectEntry(current);
        this.projectCache.set(startDir, project);
        return project;
      }

      const parent = parentOf(current);
      if (parent === current) {
        // Reached filesystem root
        this.projectCache.set(startDir, null);
        return null;
      }

      // Stop at workspace root — we don't consider the workspace root itself a project
      if (resolve(parent) === this.workspaceRoot) {
        // Check if workspace root itself has markers (edge case)
        if (hasProjectMarker(parent)) {
          const project = this.buildProjectEntry(parent);
          this.projectCache.set(startDir, project);
          return project;
        }
        this.projectCache.set(startDir, null);
        return null;
      }

      current = parent;
    }
  }

  /**
   * Resolve a project path by name.
   * Scans all workspace projects and returns the first match (case-insensitive on basename).
   */
  resolveProjectPath(name: string): string | null {
    const normalized = normalizeProjectName(name);
    if (!normalized) return null;

    // Check cache
    const cached = this.projectCache.get(`__name__${normalized.toLowerCase()}`);
    if (cached !== undefined) return cached?.root ?? null;

    const projects = this.scanAllProjects();

    // Direct basename match (case-insensitive)
    for (const project of projects) {
      if (project.name.toLowerCase() === normalized.toLowerCase()) {
        this.projectCache.set(`__name__${normalized.toLowerCase()}`, project);
        return project.root;
      }
    }

    // Check aliases
    const canonicalName = resolveCanonicalName(normalized);
    if (canonicalName.toLowerCase() !== normalized.toLowerCase()) {
      for (const project of projects) {
        if (project.name.toLowerCase() === canonicalName.toLowerCase()) {
          this.projectCache.set(`__name__${normalized.toLowerCase()}`, project);
          return project.root;
        }
      }
    }

    // Check if it's a raw path that exists
    if (existsSync(normalized) && hasProjectMarker(normalized)) {
      const project = this.buildProjectEntry(resolve(normalized));
      this.projectCache.set(`__name__${normalized.toLowerCase()}`, project);
      return project.root;
    }

    this.projectCache.set(`__name__${normalized.toLowerCase()}`, null);
    return null;
  }

  /**
   * Get all known project names (for CLI validation).
   */
  getProjectNames(): string[] {
    return this.scanAllProjects().map((p) => p.name.toLowerCase());
  }

  /**
   * Check if a name matches a known project.
   */
  isKnownProject(name: string): boolean {
    const normalized = normalizeProjectName(name).toLowerCase();
    if (!normalized) return false;
    return (
      this.getProjectNames().includes(normalized) ||
      normalized in PROJECT_NAME_ALIASES ||
      Object.values(PROJECT_NAME_ALIASES).some((a) => a.toLowerCase() === normalized)
    );
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  /**
   * Scan all workspace roots for projects.
   * Results are cached until invalidated.
   */
  scanAllProjects(): WorkspaceProject[] {
    if (this.scanCache !== null) return this.scanCache;

    const projects: WorkspaceProject[] = [];
    const seen = new Set<string>();

    // Scan family directories
    for (const familyRoot of this.familyRoots) {
      const familyName = basename(familyRoot);
      for (const entry of safeReaddir(familyRoot)) {
        const entryPath = join(familyRoot, entry);
        const st = safeStat(entryPath);
        if (st === null || !st.isDirectory()) continue;
        if (entry.startsWith('.') || entry === 'node_modules') continue;

        if (hasProjectMarker(entryPath)) {
          const project = this.buildProjectEntry(entryPath, familyName);
          if (!seen.has(project.root)) {
            seen.add(project.root);
            projects.push(project);
          }
        }
      }
    }

    // Scan direct children of workspace root
    for (const entry of safeReaddir(this.workspaceRoot)) {
      const entryPath = join(this.workspaceRoot, entry);
      const st = safeStat(entryPath);
      if (st === null || !st.isDirectory()) continue;
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      // Skip family directories themselves
      if (FAMILY_DIRECTORIES.includes(entry)) continue;

      if (hasProjectMarker(entryPath)) {
        const project = this.buildProjectEntry(entryPath);
        if (!seen.has(project.root)) {
          seen.add(project.root);
          projects.push(project);
        }
      }
    }

    this.scanCache = projects;
    return projects;
  }

  // ── Workspace context ─────────────────────────────────────────────────────

  /**
   * Build full workspace context for a given directory.
   * Collects cascading context files from workspace root to project root.
   */
  buildWorkspaceContext(cwd?: string): WorkspaceContext {
    const startDir = resolve(cwd ?? process.cwd());
    const project = this.detectFromCwd(startDir);
    const siblings = this.scanAllProjects().filter((p) => p.root !== project?.root);

    // Collect cascading context files
    const contextFiles: string[] = [];
    const dirsToCheck: string[] = [];

    // Walk from project root up to workspace root, collecting context files
    let current = project?.root ?? startDir;
    while (true) {
      dirsToCheck.push(current);
      if (resolve(current) === this.workspaceRoot) break;
      const parent = parentOf(current);
      if (parent === current) break;
      current = parent;
    }

    // Check in reverse order (workspace root first, project root last)
    for (const dir of dirsToCheck.reverse()) {
      for (const contextFile of CASCADING_CONTEXT_FILES) {
        const fullPath = join(dir, contextFile);
        if (existsSync(fullPath) && !contextFiles.includes(fullPath)) {
          contextFiles.push(fullPath);
        }
      }
      // Also check PROJECT_CONTEXT.md at each level
      const projectContextPath = join(dir, 'PROJECT_CONTEXT.md');
      if (existsSync(projectContextPath) && !contextFiles.includes(projectContextPath)) {
        contextFiles.push(projectContextPath);
      }
      // Check LLM_COLLABORATION_SYSTEM
      const llmCollabPath = join(dir, 'LLM_COLLABORATION_SYSTEM', 'README_FOR_HUMANS_AND_LLMS.md');
      if (existsSync(llmCollabPath) && !contextFiles.includes(llmCollabPath)) {
        contextFiles.push(llmCollabPath);
      }
    }

    // Monorepo detection: check if project root has subdirectories that also have markers
    const monorepo =
      project !== null &&
      safeReaddir(project.root)
        .filter((e) => !e.startsWith('.') && e !== 'node_modules')
        .some((e) => {
          const p = join(project.root, e);
          const st = safeStat(p);
          return st !== null && st.isDirectory() && hasProjectMarker(p);
        });

    return {
      workspaceRoot: this.workspaceRoot,
      project,
      contextFiles,
      monorepo,
      siblingProjects: siblings,
    };
  }

  /**
   * Get the family directory name for a project path.
   */
  getFamilyForPath(projectRoot: string): string | undefined {
    const resolved = resolve(projectRoot);
    for (const familyRoot of this.familyRoots) {
      if (isPathInside(familyRoot, resolved) && resolved !== resolve(familyRoot)) {
        return basename(familyRoot);
      }
    }
    return undefined;
  }

  /**
   * Derive overlay ID for a project based on convention.
   * Checks for `.babel-overlay.json` first, then falls back to naming convention.
   */
  resolveOverlayId(projectRoot: string): string | null {
    // Check for explicit overlay config
    const overlayConfigPath = join(projectRoot, '.babel-overlay.json');
    if (existsSync(overlayConfigPath)) {
      try {
        const config = JSON.parse(readFileSync(overlayConfigPath, 'utf-8')) as {
          overlayId?: string;
        };
        if (typeof config.overlayId === 'string' && config.overlayId.length > 0) {
          return config.overlayId;
        }
      } catch {
        // Fall through to convention
      }
    }

    // Derive from family + name convention
    const family = this.getFamilyForPath(projectRoot);
    const projectName = basename(projectRoot);

    // Family-based overlay (multiple projects share a family overlay)
    if (family === 'example_game_suite') {
      // godot_td gets its own overlay, others use project_games
      if (projectName.toLowerCase() === 'towerdefensegodot') {
        return 'overlay_godot_td';
      }
      return 'overlay_project_games';
    }
    if (family === 'Project_SaaS') {
      // Check for project-specific overlay pattern
      const specificOverlay = `overlay_${projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
      return specificOverlay;
    }
    if (family === 'example_mobile_suite') {
      if (projectName.toLowerCase() === 'montecarloledger') {
        return 'overlay_monte_carlo_ledger';
      }
      return 'overlay_project_android';
    }

    // Direct workspace root children — use project name convention
    if (family === undefined) {
      return `overlay_${projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    }

    // Generic family-based
    return `overlay_${family.toLowerCase()}`;
  }

  /**
   * Derive repo key for a project (used in local learning / policy paths).
   */
  resolveRepoKey(projectRoot: string): string {
    const projectName = basename(projectRoot)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
    // Known mappings from the old PROJECT_REPO_KEY_MAP
    const knownKeys: Record<string, string> = {
      aetherlyngamedraft: 'aetherlyn',
    };
    return knownKeys[projectName] ?? projectName;
  }

  /**
   * Invalidate caches (call after workspace structure changes).
   */
  invalidate(): void {
    this.projectCache.clear();
    this.scanCache = null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildProjectEntry(root: string, family?: string): WorkspaceProject {
    return {
      name: basename(root),
      root: resolve(root),
      ...(family ? { family } : {}),
      markers: getProjectMarkers(root),
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let defaultScanner: WorkspaceScanner | null = null;

/**
 * Get or create the default WorkspaceScanner.
 * Uses BABEL_ROOT env var, or walks up from __dirname to find prompt_catalog.yaml.
 */
export function getWorkspaceScanner(babelRoot?: string): WorkspaceScanner {
  if (defaultScanner && !babelRoot) return defaultScanner;

  const root = babelRoot ?? process.env['BABEL_ROOT'];
  if (root) {
    defaultScanner = WorkspaceScanner.fromBabelRoot(root);
    return defaultScanner;
  }

  // Fallback: walk up from cwd to find prompt_catalog.yaml
  let current = resolve(process.cwd());
  while (true) {
    if (existsSync(join(current, 'prompt_catalog.yaml'))) {
      defaultScanner = WorkspaceScanner.fromBabelRoot(current);
      return defaultScanner;
    }
    const parent = parentOf(current);
    if (parent === current) break;
    current = parent;
  }

  // Last resort: use cwd's parent as workspace root
  defaultScanner = new WorkspaceScanner(dirname(process.cwd()));
  return defaultScanner;
}

/**
 * Reset the singleton (for testing).
 */
export function resetWorkspaceScanner(): void {
  defaultScanner = null;
}

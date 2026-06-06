import MiniSearch from 'minisearch';
import { existsSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

export interface FileDocument {
  id: string;
  path: string;
  name: string;
  content: string;
  extension: string;
}

export interface SearchHit {
  id: string;
  name: string;
  score: number;
}

export interface RepoMapEntry {
  path: string;
  extension: string;
  symbols: string[];
  preview?: string;
}

export interface RepoMap {
  schema_version: 1;
  root: string;
  generated_at: string;
  files_indexed: number;
  entries: RepoMapEntry[];
}

export interface RepoMapOptions {
  limit?: number;
  target?: string | undefined;
  includePreview?: boolean;
}

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.gradle',
  '.html',
  '.java',
  '.js',
  '.json',
  '.kt',
  '.md',
  '.mjs',
  '.py',
  '.scss',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'runs',
]);

function createMiniSearch(): MiniSearch<FileDocument> {
  return new MiniSearch({
    fields: ['id', 'name', 'content'],
    storeFields: ['id', 'name'],
    searchOptions: {
      boost: { name: 2, id: 1.5, content: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
}

function normalizeRepoPath(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).replace(/\\/g, '/');
}

function extractSymbols(content: string, extension: string): string[] {
  const patterns = extension === '.py'
    ? [/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/gm, /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/gm]
    : [
        /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
        /^\s*(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
        /^\s*export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
        /^\s*class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
        /^\s*export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
        /^\s*export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
        /^\s*export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
      ];

  const symbols = new Set<string>();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const symbol = match[1]?.trim();
      if (symbol) {
        symbols.add(symbol);
      }
    }
  }
  return [...symbols].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right),
  );
}

function previewContent(content: string): string {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, 3)
    .join(' ')
    .slice(0, 240);
}

export class SemanticIndexer {
  private miniSearch: MiniSearch<FileDocument> = createMiniSearch();
  private indexedCount = 0;

  public async indexProject(rootPath: string): Promise<number> {
    const root = resolve(rootPath);
    const files = await collectTextFiles(root);
    const documents: FileDocument[] = [];

    for (const filePath of files) {
      try {
        const relativePath = normalizeRepoPath(root, filePath);
        const fd = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(1024);
        const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
        await fd.close();
        const content = buffer.toString('utf8', 0, bytesRead);

        documents.push({
          id: relativePath,
          path: filePath,
          name: relativePath.split('/').pop() || '',
          content,
          extension: extname(filePath),
        });
      } catch {
        // Skip unreadable files.
      }
    }

    this.miniSearch = createMiniSearch();
    this.miniSearch.addAll(documents);
    this.indexedCount = documents.length;
    return this.indexedCount;
  }

  public search(query: string, limit = 5): SearchHit[] {
    return this.miniSearch.search(query).slice(0, limit).map(hit => ({
      id: String(hit.id),
      name: typeof hit.name === 'string' ? hit.name : String(hit.id),
      score: typeof hit.score === 'number' ? hit.score : 0,
    }));
  }

  public get count(): number {
    return this.indexedCount;
  }
}

export async function collectTextFiles(dir: string, allFiles: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) {
    return allFiles;
  }

  if (!statSync(dir).isDirectory()) {
    return allFiles;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await collectTextFiles(fullPath, allFiles);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      allFiles.push(fullPath);
    }
  }
  return allFiles;
}

export async function buildRepoMap(
  rootPath: string,
  options: RepoMapOptions = {},
): Promise<RepoMap> {
  const root = resolve(rootPath);
  const targetPrefix = options.target?.replace(/\\/g, '/').replace(/^\.\//, '');
  const limit = Math.max(1, options.limit ?? 200);
  const files = (await collectTextFiles(root))
    .map(filePath => ({ filePath, relativePath: normalizeRepoPath(root, filePath) }))
    .filter(entry => targetPrefix ? entry.relativePath.startsWith(targetPrefix) : true)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .slice(0, limit);

  const entries: RepoMapEntry[] = [];
  for (const { filePath, relativePath } of files) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const extension = extname(filePath).toLowerCase();
      entries.push({
        path: relativePath,
        extension,
        symbols: extractSymbols(content.slice(0, 16_384), extension),
        ...(options.includePreview ? { preview: previewContent(content) } : {}),
      });
    } catch {
      // Skip unreadable files.
    }
  }

  return {
    schema_version: 1,
    root,
    generated_at: new Date().toISOString(),
    files_indexed: entries.length,
    entries,
  };
}

export function formatRepoMapHuman(repoMap: RepoMap): string {
  return [
    `Repo map: ${repoMap.root}`,
    `Files indexed: ${repoMap.files_indexed}`,
    ...repoMap.entries.map(entry => {
      const symbolText = entry.symbols.length > 0 ? ` symbols=${entry.symbols.join(',')}` : '';
      return `  ${entry.path}${symbolText}`;
    }),
  ].join('\n');
}

export const globalIndexer = new SemanticIndexer();

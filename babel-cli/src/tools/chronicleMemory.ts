import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { globalIndexer } from '../services/indexer.js';
import { createEmbeddingProvider } from '../services/embeddingProvider.js';
import { formatSemanticSearchHits } from './repoSearch.js';
import type { ToolResult } from '../sandbox.js';
import type { ToolCallRequest } from '../localTools.js';
import { isDryRunEnabled } from '../config/dryRun.js';
import { JsonChronicleStore } from './jsonChronicleStore.js';
import {
  parseChronicleBackend,
  type ChronicleBackend,
  type ChronicleStore,
} from './chronicleStore.js';

const CHRONICLE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', // tools/ -> dist/
  '..', // dist/ -> babel-cli/
);

interface LoadedChronicleStore {
  backend: Exclude<ChronicleBackend, 'auto'>;
  cacheKey: string;
  store: ChronicleStore;
}

let loadedChronicleStore: LoadedChronicleStore | undefined;

function resolveChronicleSqlitePath(): string {
  return (
    process.env['BABEL_CHRONICLE_DB_PATH']?.trim() || path.join(CHRONICLE_ROOT, 'chronicle.sqlite')
  );
}

function resolveChronicleJsonPath(): string {
  return (
    process.env['BABEL_CHRONICLE_JSON_PATH']?.trim() || path.join(CHRONICLE_ROOT, 'chronicle.json')
  );
}

function getJsonChronicleStore(cacheKey: string): LoadedChronicleStore {
  return {
    backend: 'json',
    cacheKey,
    store: new JsonChronicleStore(resolveChronicleJsonPath()),
  };
}

async function getChronicleStore(): Promise<LoadedChronicleStore> {
  const requestedBackend = parseChronicleBackend(process.env['BABEL_CHRONICLE_BACKEND']);
  const cacheKey = [
    requestedBackend,
    resolveChronicleSqlitePath(),
    resolveChronicleJsonPath(),
  ].join('\0');

  if (loadedChronicleStore?.cacheKey === cacheKey) {
    return loadedChronicleStore;
  }

  loadedChronicleStore?.store.close();

  if (requestedBackend === 'json') {
    loadedChronicleStore = getJsonChronicleStore(cacheKey);
    return loadedChronicleStore;
  }

  try {
    const { SqliteChronicleStore } = await import('./sqliteChronicleStore.js');
    loadedChronicleStore = {
      backend: 'sqlite',
      cacheKey,
      store: new SqliteChronicleStore(resolveChronicleSqlitePath()),
    };
    return loadedChronicleStore;
  } catch (err: unknown) {
    if (requestedBackend === 'sqlite') {
      throw err;
    }

    loadedChronicleStore = getJsonChronicleStore(cacheKey);
    return loadedChronicleStore;
  }
}

export function resetChronicleStoreForTests(): void {
  loadedChronicleStore?.store.close();
  loadedChronicleStore = undefined;
}

export async function handleMemoryStore(
  req: Extract<ToolCallRequest, { tool: 'memory_store' }>,
): Promise<ToolResult> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();

  if (isDryRunEnabled()) {
    console.log(
      `  [DRY RUN] memory_store -> key="${req.key}" ` +
        `value="${req.value.slice(0, 80)}${req.value.length > 80 ? '...' : ''}"`,
    );
    return {
      exit_code: 0,
      stdout: `[DRY RUN] Would store fact: key="${req.key}" for project "${projectRoot}"`,
      stderr: '',
    };
  }

  console.log(`  [CHRONICLE] memory_store -> key="${req.key}"`);

  try {
    const chronicle = await getChronicleStore();
    chronicle.store.storeFact(projectRoot, req.key, req.value);

    return {
      exit_code: 0,
      stdout: `[CHRONICLE] Stored: key="${req.key}" for project "${projectRoot}"`,
      stderr: '',
    };
  } catch (err: unknown) {
    return {
      exit_code: 1,
      stdout: '',
      stderr:
        `[CHRONICLE_ERROR] memory_store failed for key="${req.key}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function handleMemoryQuery(
  req: Extract<ToolCallRequest, { tool: 'memory_query' }>,
): Promise<ToolResult> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();

  console.log(`  [CHRONICLE] memory_query -> key="${req.key}"`);

  try {
    const chronicle = await getChronicleStore();

    if (req.key === 'ALL') {
      return {
        exit_code: 0,
        stdout: JSON.stringify(chronicle.store.listFacts(projectRoot)),
        stderr: '',
      };
    }

    return {
      exit_code: 0,
      stdout: chronicle.store.getFact(projectRoot, req.key) ?? '',
      stderr: '',
    };
  } catch (err: unknown) {
    return {
      exit_code: 1,
      stdout: '',
      stderr:
        `[CHRONICLE_ERROR] memory_query failed for key="${req.key}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function ensureSemanticIndexForProject(
  projectRoot: string,
  onProgress?: (indexed: number, total: number) => void,
): Promise<void> {
  const root = path.resolve(projectRoot);
  if (globalIndexer.indexedProjectRoot === root && globalIndexer.count > 0) {
    return;
  }
  await globalIndexer.indexProject(root, onProgress ? { onProgress } : undefined);
}

let embeddingRegistered = false;

export async function handleSemanticSearch(
  req: Extract<ToolCallRequest, { tool: 'semantic_search' }>,
): Promise<ToolResult> {
  try {
    // ── Lazily register embedding function on first semantic search ──
    if (!embeddingRegistered) {
      embeddingRegistered = true;
      const provider = createEmbeddingProvider();
      if (provider) {
        globalIndexer.setEmbeddingFunction((text) =>
          provider.embedTexts([text]).then((vs) => vs[0]!),
        );
      }
    }

    const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
    await ensureSemanticIndexForProject(projectRoot);

    const hits = await globalIndexer.searchWithEmbedding(req.query, req.limit ?? 5);

    return {
      exit_code: 0,
      stdout: formatSemanticSearchHits(hits),
      stderr: '',
    };
  } catch (err: unknown) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `Semantic search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

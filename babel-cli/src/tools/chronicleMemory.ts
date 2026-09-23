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
import { getExecutionContext, isIndexWriteDenied } from '../agent/executionContext.js';

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

const loadedChronicleStores = new Map<string, Promise<LoadedChronicleStore>>();
const openedChronicleStores = new Set<ChronicleStore>();

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

function getJsonChronicleStore(cacheKey: string, jsonPath: string): LoadedChronicleStore {
  return {
    backend: 'json',
    cacheKey,
    store: new JsonChronicleStore(jsonPath),
  };
}

async function getChronicleStore(): Promise<LoadedChronicleStore> {
  const requestedBackend = parseChronicleBackend(process.env['BABEL_CHRONICLE_BACKEND']);
  const sqlitePath = resolveChronicleSqlitePath();
  const jsonPath = resolveChronicleJsonPath();
  const cacheKey = [
    requestedBackend,
    sqlitePath,
    jsonPath,
  ].join('\0');

  const existing = loadedChronicleStores.get(cacheKey);
  if (existing) return existing;
  const opening = (async (): Promise<LoadedChronicleStore> => {
    if (requestedBackend === 'json') return getJsonChronicleStore(cacheKey, jsonPath);
    try {
      const { SqliteChronicleStore } = await import('./sqliteChronicleStore.js');
      return { backend: 'sqlite', cacheKey, store: new SqliteChronicleStore(sqlitePath) };
    } catch (err: unknown) {
      if (requestedBackend === 'sqlite') throw err;
      return getJsonChronicleStore(cacheKey, jsonPath);
    }
  })();
  loadedChronicleStores.set(cacheKey, opening);
  try {
    const loaded = await opening;
    openedChronicleStores.add(loaded.store);
    return loaded;
  } catch (err) {
    loadedChronicleStores.delete(cacheKey);
    throw err;
  }
}

export function resetChronicleStoreForTests(): void {
  for (const store of openedChronicleStores) store.close();
  openedChronicleStores.clear();
  loadedChronicleStores.clear();
}

/** Capture the authorized root before any asynchronous store or index operation. */
function toolProjectRoot(declaredRoot?: string): string {
  const scoped = getExecutionContext()?.root;
  if (scoped) {
    if (declaredRoot && path.resolve(declaredRoot) !== path.resolve(scoped)) {
      throw new Error('Tool project root differs from the authorized execution root');
    }
    return path.resolve(scoped);
  }
  // Ordinary tool dispatch passes ToolContext.projectRoot. A standalone caller
  // must provide an explicit root instead of borrowing process-wide state.
  if (!declaredRoot) throw new Error('Tool project root requires execution context or an explicit root');
  return path.resolve(declaredRoot);
}

export async function handleMemoryStore(
  req: Extract<ToolCallRequest, { tool: 'memory_store' }>,
  declaredRoot?: string,
): Promise<ToolResult> {
  const projectRoot = toolProjectRoot(declaredRoot);

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
  declaredRoot?: string,
): Promise<ToolResult> {
  const projectRoot = toolProjectRoot(declaredRoot);

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
  if (globalIndexer.isReadyForRoot(root)) {
    return;
  }
  await globalIndexer.indexProject(root, onProgress ? { onProgress } : undefined);
}

let embeddingRegistered = false;

export async function handleSemanticSearch(
  req: Extract<ToolCallRequest, { tool: 'semantic_search' }>,
  declaredRoot?: string,
): Promise<ToolResult> {
  try {
    const projectRoot = toolProjectRoot(declaredRoot);
    // S04/#214: execution-scoped policy (env is only a startup/child-process seed).
    const readOnlyNoIndexWrites = isIndexWriteDenied();

    if (!readOnlyNoIndexWrites) {
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
    }

    const hits = await globalIndexer.withProjectIndex(projectRoot, !readOnlyNoIndexWrites, () =>
      readOnlyNoIndexWrites
        ? Promise.resolve(globalIndexer.search(req.query, req.limit ?? 5))
        : globalIndexer.searchWithEmbedding(req.query, req.limit ?? 5),
    );

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

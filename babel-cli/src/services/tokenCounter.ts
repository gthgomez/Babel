import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getEncoding } from 'js-tiktoken';

import type { CatalogEntry } from '../control-plane/catalog.js';

export const TOKENIZER_ENCODING = 'o200k_base' as const;

const FILE_BOUNDARY_OPEN = (name: string): string => `\n\n--- START OF FILE: ${name} ---\n\n`;
const FILE_BOUNDARY_CLOSE = (name: string): string => `\n\n--- END OF FILE: ${name} ---`;

export type TokenCountSource = 'runtime' | 'audit' | 'unavailable';

export interface ActualTokenMeasurement {
  actualPromptTokens: number | null;
  actualTokenByEntry: Record<string, number>;
  tokenizerEncoding: typeof TOKENIZER_ENCODING;
  tokenCountSource: TokenCountSource;
  warnings: string[];
}

export interface EntryTokenMeasurement {
  id: string;
  layer: string;
  relativePath: string;
  declaredTokenBudget: number | null;
  actualCompiledTokens: number;
  deltaFromDeclared: number | null;
  tags: string[];
}

export interface TokenCountEntryInput {
  id: string;
  absolutePath: string;
}

const encoder = getEncoding(TOKENIZER_ENCODING);

/** Cache of token counts keyed on `${resolvedFilePath}:${mtimeMs}`. */
const tokenCountCache = new Map<string, number>();

export function clearTokenCountCache(): void {
  tokenCountCache.clear();
}

export function countTextTokens(text: string): number {
  return encoder.encode(text).length;
}

export function buildWrappedPromptEntry(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  const name = basename(filePath);
  return FILE_BOUNDARY_OPEN(name) + content.trimEnd() + FILE_BOUNDARY_CLOSE(name);
}

export function buildPromptOnlyFromManifestPaths(paths: string[]): string {
  return paths.map((filePath) => buildWrappedPromptEntry(filePath)).join('');
}

export function countPromptManifestTokens(
  paths: string[],
  source: TokenCountSource = 'runtime',
): ActualTokenMeasurement {
  const actualTokenByEntry: Record<string, number> = {};
  const warnings: string[] = [];
  let actualPromptTokens: number | null = null;

  for (const filePath of paths) {
    try {
      if (!existsSync(filePath)) {
        throw new Error(`Prompt manifest path does not exist: ${filePath}`);
      }
      const cacheKey = `${filePath}:${statSync(filePath).mtimeMs}`;
      let tokenCount = tokenCountCache.get(cacheKey);
      if (tokenCount === undefined) {
        tokenCount = countTextTokens(buildWrappedPromptEntry(filePath));
        tokenCountCache.set(cacheKey, tokenCount);
      }
      actualTokenByEntry[filePath] = tokenCount;
      if (actualPromptTokens === null) {
        actualPromptTokens = 0;
      }
      actualPromptTokens += tokenCount;
    } catch (error: unknown) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    actualPromptTokens,
    actualTokenByEntry,
    tokenizerEncoding: TOKENIZER_ENCODING,
    tokenCountSource: actualPromptTokens === null ? 'unavailable' : source,
    warnings,
  };
}

export function countSelectedEntryTokens(
  entries: TokenCountEntryInput[],
  source: TokenCountSource = 'runtime',
): ActualTokenMeasurement {
  const actualTokenByEntry: Record<string, number> = {};
  const warnings: string[] = [];
  let actualPromptTokens = 0;

  for (const entry of entries) {
    try {
      if (!existsSync(entry.absolutePath)) {
        throw new Error(
          `Prompt manifest path does not exist for ${entry.id}: ${entry.absolutePath}`,
        );
      }
      const cacheKey = `${entry.absolutePath}:${statSync(entry.absolutePath).mtimeMs}`;
      let tokenCount = tokenCountCache.get(cacheKey);
      if (tokenCount === undefined) {
        tokenCount = countTextTokens(buildWrappedPromptEntry(entry.absolutePath));
        tokenCountCache.set(cacheKey, tokenCount);
      }
      actualTokenByEntry[entry.id] = tokenCount;
      actualPromptTokens += tokenCount;
    } catch (error: unknown) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    actualPromptTokens,
    actualTokenByEntry,
    tokenizerEncoding: TOKENIZER_ENCODING,
    tokenCountSource: source,
    warnings,
  };
}

export function countEntryTokens(entry: CatalogEntry, babelRoot: string): EntryTokenMeasurement {
  const absolutePath = join(babelRoot, entry.path ?? '');
  if (!entry.path || !existsSync(absolutePath)) {
    throw new Error(`Cannot measure entry ${entry.id}; resolved path missing: ${absolutePath}`);
  }

  const cacheKey = `${absolutePath}:${statSync(absolutePath).mtimeMs}`;
  let actualCompiledTokens = tokenCountCache.get(cacheKey);
  if (actualCompiledTokens === undefined) {
    actualCompiledTokens = countTextTokens(buildWrappedPromptEntry(absolutePath));
    tokenCountCache.set(cacheKey, actualCompiledTokens);
  }
  return {
    id: entry.id,
    layer: entry.layer,
    relativePath: entry.path,
    declaredTokenBudget: entry.tokenBudget,
    actualCompiledTokens,
    deltaFromDeclared: entry.tokenBudget === null ? null : actualCompiledTokens - entry.tokenBudget,
    tags: [...entry.tags],
  };
}

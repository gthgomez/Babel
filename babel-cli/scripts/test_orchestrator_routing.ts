import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCatalog } from '../src/control-plane/catalog.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const babelRoot = resolve(scriptDir, '..', '..');
const v9Path = join(babelRoot, '00_System_Router', 'OLS-v9-Orchestrator.md');
const v8Path = join(babelRoot, '00_System_Router', 'OLS-v8-Orchestrator.md');
const catalogPath = join(babelRoot, 'prompt_catalog.yaml');

const v9Text = readFileSync(v9Path, 'utf-8');
const catalog = parseCatalog(catalogPath);
const catalogIds = new Set(catalog.map(entry => entry.id));

function assertContains(text: string, needle: string, label: string): void {
  assert(text.includes(needle), `${label}: expected to find "${needle}"`);
}

function assertCatalogIdExists(id: string): void {
  assert(catalogIds.has(id), `catalog mismatch: expected id "${id}" to exist in prompt_catalog.yaml`);
}

function assertPromptIdsExist(text: string, label: string): void {
  const excluded = new Set([
    'behavioral_ids',
    'domain_id',
    'skill_ids',
    'model_adapter_id',
    'pipeline_mode',
    'project_overlay_id',
    'task_overlay_ids',
    'pipeline_stage_ids',
  ]);
  const ids = new Set(
    (text.match(/\b(?:behavioral|domain|skill|adapter|overlay|pipeline)_[a-z0-9_]+\b/g) ?? [])
      .filter(id => !excluded.has(id)),
  );
  for (const id of ids) {
    assertCatalogIdExists(id);
  }
  assert(ids.size > 0, `${label}: expected at least one catalog id reference`);
}

function runV9CoverageChecks(): void {
  assertContains(v9Text, 'Mobile/Android', 'v9 mobile routing table');
  assertContains(v9Text, '`domain_android_kotlin`', 'v9 mobile domain');

  for (const id of [
    'skill_android_app_bundle',
    'skill_android_release_build',
    'skill_google_play_store',
    'skill_android_play_store_compliance',
    'skill_amazon_appstore',
    'skill_samsung_galaxy_store',
  ]) {
    assertContains(v9Text, `\`${id}\``, 'v9 mobile skill selection');
    assertCatalogIdExists(id);
  }

  // Verify the canonical example block exists with expected structure
  assertContains(v9Text, 'EXAMPLE — Backend API Fix', 'v9 example heading');
  assertContains(v9Text, '"domain_id": "domain_swe_backend"', 'v9 example domain');
  assertContains(v9Text, '"skill_ids": ["skill_ts_zod", "skill_supabase_pg"]', 'v9 example skills');
  assertContains(v9Text, '"model_adapter_id": "adapter_codex_balanced"', 'v9 example model adapter');

  assertPromptIdsExist(v9Text, 'v9 prompt ids');
}

function runLegacyRemovalChecks(): void {
  assert(!existsSync(v8Path), 'expected deprecated OLS-v8 orchestrator file to be removed');
  assert(!catalogIds.has('orchestrator_v8'), 'expected prompt_catalog.yaml to omit deprecated orchestrator_v8');
}

function main(): void {
  runV9CoverageChecks();
  runLegacyRemovalChecks();
  console.log('orchestrator routing regression tests passed');
}

main();

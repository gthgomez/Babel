import { readFileSync } from 'node:fs';
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
const v8Text = readFileSync(v8Path, 'utf-8');
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
  assertContains(v9Text, '`example_mobile_suite`', 'v9 active projects');
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

  assertContains(v9Text, 'Example — Android AAB release build', 'v9 AAB example heading');
  assertContains(v9Text, '"domain_id": "domain_android_kotlin"', 'v9 AAB example domain');
  assertContains(v9Text, '"skill_ids": ["skill_android_app_bundle", "skill_android_release_build"]', 'v9 AAB example skills');

  assertContains(v9Text, 'Example — Google Play listing/compliance task', 'v9 Play listing example heading');
  assertContains(v9Text, '"skill_ids": ["skill_google_play_store"]', 'v9 Play listing example skills');

  assertContains(v9Text, 'Example — Amazon + Samsung multi-store distribution', 'v9 multi-store example heading');
  assertContains(v9Text, '"skill_ids": ["skill_android_app_bundle", "skill_amazon_appstore", "skill_samsung_galaxy_store"]', 'v9 multi-store example skills');

  assertPromptIdsExist(v9Text, 'v9 prompt ids');
}

function runV8GuardrailChecks(): void {
  assertContains(v8Text, 'Legacy compatibility only — not actively maintained', 'v8 legacy mode');
  assertContains(v8Text, 'mobile/android routing is not maintained in v8', 'v8 mobile guardrail');
  assertContains(v8Text, 'Prefer OLS-v9', 'v8 v9 recommendation');
}

function main(): void {
  runV9CoverageChecks();
  runV8GuardrailChecks();
  console.log('orchestrator routing regression tests passed');
}

main();

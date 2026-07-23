import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearCompilerCacheForTests,
  compileContext,
  compileContextSync,
  resolveInstructionStackManifest,
} from './compiler.js';

function withCompilerEnv<T>(cachePath: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env['BABEL_CONTEXT_CACHE_PATH'];
  process.env['BABEL_CONTEXT_CACHE_PATH'] = cachePath;
  clearCompilerCacheForTests();

  return run().finally(() => {
    clearCompilerCacheForTests();
    if (previous === undefined) {
      delete process.env['BABEL_CONTEXT_CACHE_PATH'];
    } else {
      process.env['BABEL_CONTEXT_CACHE_PATH'] = previous;
    }
  });
}

test('compileContext matches compileContextSync output for the same manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-compiler-test-'));
  try {
    const filePath = join(root, 'layer.md');
    const cachePath = join(root, 'compiler-cache.json');
    writeFileSync(filePath, '# Layer\n\ncontent\n', 'utf-8');

    await withCompilerEnv(cachePath, async () => {
      const asyncContext = await compileContext([filePath], 'Ship it.');
      const syncContext = compileContextSync([filePath], 'Ship it.');
      assert.equal(asyncContext, syncContext);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compileContext persists cache entries and refreshes them after file changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-compiler-cache-'));
  try {
    const filePath = join(root, 'layer.md');
    const cachePath = join(root, 'compiler-cache.json');
    writeFileSync(filePath, 'version-one\n', 'utf-8');

    await withCompilerEnv(cachePath, async () => {
      const first = await compileContext([filePath], 'First task');
      assert.match(first, /version-one/);
      assert.equal(existsSync(cachePath), true);

      const firstCache = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
        files?: Record<string, { sha256?: string }>;
      };
      const firstHash = firstCache.files?.[filePath]?.sha256;
      assert.equal(typeof firstHash, 'string');

      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(filePath, 'version-two\n', 'utf-8');

      const second = await compileContext([filePath], 'Second task');
      assert.match(second, /version-two/);

      const secondCache = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
        files?: Record<string, { sha256?: string }>;
      };
      const secondHash = secondCache.files?.[filePath]?.sha256;
      assert.equal(typeof secondHash, 'string');
      assert.notEqual(secondHash, firstHash);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolver normalizes common hallucinated benchmark skill ids', () => {
  const babelRoot = join(process.cwd(), '..');
  const manifest = {
    target_project: 'global',
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v10'],
      domain_id: 'domain_devops',
      skill_ids: [
        'skill_csv_writer',
        'skill_file_operations',
        'skill_python',
        'skill_python_validation',
        'skill_python_verification',
      ],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: null,
      task_overlay_ids: ['overlay_terminal_bench'],
      pipeline_stage_ids: [],
    },
    resolution_policy: {
      apply_domain_default_skills: false,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
      task_shape_profile: 'full',
    },
  };

  const resolved = resolveInstructionStackManifest(manifest as never, babelRoot) as {
    compilation_state?: string;
    compiled_artifacts?: { selected_entry_ids?: string[]; warnings?: string[] };
  };

  const selectedIds = resolved.compiled_artifacts?.selected_entry_ids ?? [];
  assert.equal(resolved.compilation_state, 'compiled');
  assert.equal(selectedIds.includes('skill_exact_output_schema'), true);
  assert.equal(selectedIds.includes('skill_python_backend'), true);
  assert.equal(selectedIds.includes('skill_csv_writer'), false);
  assert.equal(selectedIds.includes('skill_file_operations'), false);
  assert.equal(selectedIds.includes('skill_python'), false);
  assert.equal(selectedIds.includes('skill_python_validation'), false);
});

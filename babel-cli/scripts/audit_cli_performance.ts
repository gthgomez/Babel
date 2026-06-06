import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  compileContext,
  compileContextSync,
  resolveInstructionStackManifest,
} from '../src/compiler.js';

interface TimedResult<T> {
  durationMs: number;
  value: T;
}

function timeCall<T>(fn: () => T): TimedResult<T> {
  const start = performance.now();
  const value = fn();
  return {
    durationMs: performance.now() - start,
    value,
  };
}

async function timeCallAsync<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now();
  const value = await fn();
  return {
    durationMs: performance.now() - start,
    value,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index] ?? 0;
}

function buildCliInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/c', command, ...args],
    };
  }

  return { command, args };
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const cliRoot = resolve(scriptDir, '..');
  const repoRoot = resolve(cliRoot, '..');
  const benchmarkDir = join(repoRoot, 'runs', 'benchmarks');
  mkdirSync(benchmarkDir, { recursive: true });

  const cachePath = join(tmpdir(), `babel-compiler-audit-${process.pid}.json`);
  rmSync(cachePath, { force: true });

  const manifest = resolveInstructionStackManifest({
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: 'Performance audit benchmark',
      task_category: 'DevOps',
      secondary_category: null,
      complexity_estimate: 'Low',
      pipeline_mode: 'verified',
      ambiguity_note: null,
      routing_confidence: 1,
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
      domain_id: 'domain_swe_backend',
      skill_ids: ['skill_ts_zod', 'skill_bcdp_contracts'],
      model_adapter_id: 'adapter_claude',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: ['pipeline_qa_reviewer'],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
    },
    platform_profile: {
      profile_source: 'not_required_for_routing',
      client_surface: 'unspecified',
      container_model: null,
      ingestion_mode: 'none',
      repo_write_mode: null,
      output_surface: ['none'],
      platform_modes: [],
      execution_trust: null,
      data_trust: null,
      freshness_trust: null,
      action_trust: null,
      approval_mode: 'unknown',
    },
    worker_configuration: {
      assigned_model: 'qwen3',
      rationale: 'Benchmark harness',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'Benchmark the compiler and CLI startup paths.',
      system_directive: 'Resolve the instruction stack and compile the context.',
    },
  } as never, repoRoot);

  const promptManifest = manifest.prompt_manifest;
  const totalPromptBytes = promptManifest.reduce((sum, filePath) => sum + statSync(filePath).size, 0);

  const manifestResolutionSamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const sample = timeCall(() => resolveInstructionStackManifest(manifest, repoRoot));
    manifestResolutionSamples.push(sample.durationMs);
  }

  process.env['BABEL_CONTEXT_CACHE_PATH'] = cachePath;
  const asyncCold = await timeCallAsync(() => compileContext(
    promptManifest,
    'Benchmark compile context cold path.',
  ));

  const asyncWarmSamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const sample = await timeCallAsync(() => compileContext(
      promptManifest,
      'Benchmark compile context warm path.',
    ));
    asyncWarmSamples.push(sample.durationMs);
  }

  const syncSamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const sample = timeCall(() => compileContextSync(
      promptManifest,
      'Benchmark compile context sync path.',
    ));
    syncSamples.push(sample.durationMs);
  }

  const tsxBinary = join(
    cliRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  const cliCommands = [
    ['src/index.ts', '--help'],
    ['src/index.ts', 'doctor', '--help'],
    ['src/index.ts', 'inspect', '--help'],
  ];
  const cliStartupResults = cliCommands.map((args) => {
    const samples: number[] = [];
    let exitCode = 1;
    let stderrPreview = '';
    let stdoutPreview = '';

    for (let i = 0; i < 3; i++) {
      const invocation = buildCliInvocation(tsxBinary, args);
      const start = performance.now();
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: cliRoot,
        env: {
          ...process.env,
          BABEL_ROOT: repoRoot,
          BABEL_RUNS_DIR: benchmarkDir,
          BABEL_CONTEXT_CACHE_PATH: cachePath,
        },
        encoding: 'utf8',
        windowsHide: true,
      });
      samples.push(performance.now() - start);
      exitCode = result.status ?? 1;
      stderrPreview = (result.stderr ?? '').trim().slice(0, 200);
      stdoutPreview = (result.stdout ?? '').trim().slice(0, 200);
    }

    return {
      command: `tsx ${args.join(' ')}`,
      samples,
      average: average(samples),
      p95: percentile(samples, 0.95),
      exitCode,
      stdoutPreview,
      stderrPreview,
    };
  });

  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      platform: process.platform,
      node: process.version,
      cli_root: cliRoot,
      prompt_manifest_count: promptManifest.length,
      prompt_manifest_bytes: totalPromptBytes,
    },
    manifest_resolution_ms: {
      samples: manifestResolutionSamples,
      average: average(manifestResolutionSamples),
      p95: percentile(manifestResolutionSamples, 0.95),
    },
    compile_context_ms: {
      async_cold: asyncCold.durationMs,
      async_warm_samples: asyncWarmSamples,
      async_warm_average: average(asyncWarmSamples),
      async_warm_p95: percentile(asyncWarmSamples, 0.95),
      sync_samples: syncSamples,
      sync_average: average(syncSamples),
      sync_p95: percentile(syncSamples, 0.95),
      warm_speedup_vs_sync: average(syncSamples) / average(asyncWarmSamples),
    },
    cli_startup_ms: cliStartupResults,
    caveats: [
      'This audit does not include live LLM waterfall latency because DEEPINFRA_API_KEY was not used here.',
      'CLI startup timings include tsx transpilation overhead because developer workflow commonly runs src/index.ts directly.',
      'Warm compiler timings reuse the same persistent cache file to reflect the common repeated-invocation path.',
    ],
  };

  const outputPath = join(benchmarkDir, 'cli-performance-audit.json');
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  console.log(JSON.stringify({
    status: 'ok',
    output_path: outputPath,
    manifest_resolution_average_ms: report.manifest_resolution_ms.average,
    compile_async_warm_average_ms: report.compile_context_ms.async_warm_average,
    compile_sync_average_ms: report.compile_context_ms.sync_average,
    warm_speedup_vs_sync: report.compile_context_ms.warm_speedup_vs_sync,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

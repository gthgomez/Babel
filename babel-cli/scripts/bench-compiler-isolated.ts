import { resolveInstructionStackManifest } from '../src/compiler.js';
import { join } from 'node:path';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const BABEL_ROOT = join(process.cwd(), '..');
const mockManifest = {
  instruction_stack: {
    domain_id: 'domain_swe_backend',
    skill_ids: ['skill_ts_zod', 'skill_bcdp_contracts', 'skill_android_app_bundle'],
    behavioral_ids: ['behavioral_core_v7', 'behavioral_cognitive_micro_v7', 'behavioral_guard_v7'],
    model_adapter_id: 'adapter_claude',
    task_overlay_ids: [],
    pipeline_stage_ids: []
  },
  compilation_state: 'uncompiled',
  resolution_policy: {
    apply_domain_default_skills: true,
    expand_skill_dependencies: true,
    strict_conflict_mode: 'error'
  }
};

const start = performance.now();
const resolved = resolveInstructionStackManifest(mockManifest as any, BABEL_ROOT);
const duration = performance.now() - start;

console.log(`Manifest resolution took ${duration.toFixed(4)}ms`);

const benchmarkDir = join(BABEL_ROOT, 'runs', 'benchmarks');
if (!existsSync(benchmarkDir)) mkdirSync(benchmarkDir, { recursive: true });
writeFileSync(
  join(benchmarkDir, 'manifest-latency-v9.json'),
  JSON.stringify({
    timestamp: new Date().toISOString(),
    task_length: 0,
    skill_count: mockManifest.instruction_stack.skill_ids.length,
    manifest_ms: duration,
    orchestrator_version: 'v9-mock'
  }, null, 2)
);

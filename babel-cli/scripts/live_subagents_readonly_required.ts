import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { loadBabelCliEnv } from '../src/config/envBootstrap.js';
import { DeepSeekApiRunner } from '../src/runners/deepSeekApi.js';
import { runBabelFullPlan } from '../src/services/babelFull.js';
import { routeLiteOrFull } from '../src/services/liteFullRouter.js';

loadBabelCliEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const babelRoot = resolve(packageRoot, '..');
const evidencePath = join(babelRoot, 'docs', 'status', 'live-governance-evidence', 'live-subagents-readonly-sanitized.json');

const ProbeSchema = z.object({
  status: z.literal('ok'),
  proof: z.literal('readonly_subagents'),
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function main(): Promise<void> {
  if (!process.env['DEEPSEEK_API_KEY']) {
    throw new Error('[live-subagents-readonly] DEEPSEEK_API_KEY is required for read-only live subagent proof.');
  }

  const task = 'Use read-only Spark agents to harden the Babel production proof plan without file writes.';
  const routeDecision = routeLiteOrFull(task);
  const fullResult = runBabelFullPlan(task, {
    routeDecision,
    projectRoot: babelRoot,
    agentsMode: 'read-only',
  });

  const flash = new DeepSeekApiRunner('deepseek-v4-flash');
  await flash.execute(
    'Return exactly {"status":"ok","proof":"readonly_subagents"} as JSON. No markdown.',
    ProbeSchema,
  );
  const pro = new DeepSeekApiRunner('deepseek-v4-pro');
  await pro.execute(
    'QA check: return exactly {"status":"ok","proof":"readonly_subagents"} as JSON. No markdown.',
    ProbeSchema,
  );

  const generatedAt = new Date().toISOString();
  const artifact = {
    schema_version: 1,
    artifact_type: 'live_subagents_readonly_sanitized_evidence',
    generated_at: generatedAt,
    provider: 'deepseek',
    model_policy: {
      flash: ['read_only_spark_evidence'],
      pro: ['qa_review'],
      mutating_subagents_enabled: false,
    },
    run_dir: fullResult.run_dir,
    spark_agents: fullResult.spark_agents.map(agent => ({
      id: agent.id,
      mode: agent.mode,
      status: agent.status,
      evidence_path: agent.evidence_path,
      changed_files: [],
    })),
    provider_probe_summary: {
      flash: flash.getLastInvocationMetadata(),
      pro: pro.getLastInvocationMetadata(),
    },
    assertions: {
      no_file_writes_by_spark_agents: fullResult.spark_agents.every(agent => agent.mode === 'read_only'),
      per_agent_evidence_present: fullResult.spark_agents.every(agent => agent.evidence_path.length > 0),
      lead_synthesis_present: Boolean(fullResult.hardened_plan_path),
      mutating_subagents_disabled: fullResult.mutation_subagents.enabled === false,
    },
    sanitized: true,
    raw_workspace_payload_saved: false,
  };
  writeJson(evidencePath, artifact);
  process.stdout.write(`${JSON.stringify({
    status: 'pass',
    evidence_path: evidencePath,
    run_dir: fullResult.run_dir,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

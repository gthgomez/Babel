/**
 * Clean-clone evaluation readiness. Missing catalogs/datasets are codes, not crashes.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { BABEL_ROOT } from '../cli/constants.js'
import {
  assessAgentBenchmarkReadiness,
  defaultAgentBenchmarkManifestPath,
  loadAgentBenchmarkManifest,
} from '../services/agentBenchmark.js'
import {
  defaultAdaptersPath,
  defaultManifestPath,
  defaultResultSchemaPath,
} from '../services/governanceBenchmark.js'
import { resolveTerminalBenchRoot } from '../services/agentBenchmarkHarness.js'

export type EvalDoctorCode =
  | 'OK'
  | 'CATALOG_MISSING'
  | 'DATASET_NOT_PROVISIONED'
  | 'TB_RUNNER_MISSING'
  | 'DOCKER_MISSING'

export interface EvalDoctorFinding {
  code: EvalDoctorCode
  surface: string
  detail: string
  provision?: string
}

export interface EvalDoctorReport {
  schema_version: 1
  ok: boolean
  findings: EvalDoctorFinding[]
  agent_manifest_present: boolean
  governance_catalog_present: boolean
}

function present(path: string): boolean {
  return existsSync(path)
}

/**
 * Inspect advertised eval catalogs and external dataset gates without throwing.
 */
export function runEvalDoctor(repoRoot: string = BABEL_ROOT): EvalDoctorReport {
  const findings: EvalDoctorFinding[] = []
  const agentManifest = defaultAgentBenchmarkManifestPath()
  const govManifest = defaultManifestPath()
  const adapters = defaultAdaptersPath()
  const resultSchema = defaultResultSchemaPath()
  const agentPresent = present(agentManifest)
  const govPresent = present(govManifest) && present(adapters) && present(resultSchema)

  if (!agentPresent) {
    findings.push({
      code: 'CATALOG_MISSING',
      surface: 'benchmark:agent',
      detail: `Missing ${agentManifest}`,
      provision: 'Restore benchmarks/babel-agent-benchmark/manifest.json (see benchmarks/PROVENANCE.json)',
    })
  }
  if (!govPresent) {
    findings.push({
      code: 'CATALOG_MISSING',
      surface: 'benchmark (governance)',
      detail: `Missing governance catalog under ${join(repoRoot, 'benchmarks')}`,
      provision: 'Restore task-manifest.json, tool-adapters.json, result.schema.json',
    })
  }

  if (agentPresent) {
    try {
      const manifest = loadAgentBenchmarkManifest(agentManifest)
      const readiness = assessAgentBenchmarkReadiness(manifest, agentManifest)
      if (!readiness.dataset_paths['swe_bench_verified']?.present) {
        findings.push({
          code: 'DATASET_NOT_PROVISIONED',
          surface: 'swe_bench_verified',
          detail: 'SWE-bench Verified JSONL is not provisioned (gitignored by design).',
          provision: 'npm --prefix babel-cli run benchmark:agent:provision-swebench',
        })
      }
      const tbRoot = resolveTerminalBenchRoot()
      const runner = join(tbRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs')
      if (!present(runner)) {
        findings.push({
          code: 'TB_RUNNER_MISSING',
          surface: 'terminal_bench_2_1',
          detail: `Harbor pilot missing at ${runner}`,
          provision: 'Set TERMINAL_BENCH_ROOT or restore benchmarks/scripts/run_babel_terminal_bench_pilot.mjs',
        })
      }
      if (!readiness.docker_available) {
        findings.push({
          code: 'DOCKER_MISSING',
          surface: 'docker',
          detail: 'Docker daemon not available (required for TB verifier and optional SWE docker eval).',
        })
      }
    } catch (err) {
      findings.push({
        code: 'CATALOG_MISSING',
        surface: 'benchmark:agent',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    schema_version: 1,
    ok: findings.every((f) => f.code !== 'CATALOG_MISSING'),
    findings,
    agent_manifest_present: agentPresent,
    governance_catalog_present: govPresent,
  }
}

export function formatEvalDoctorHuman(report: EvalDoctorReport): string {
  const lines = [
    `eval doctor: ${report.ok ? 'catalogs present' : 'catalogs missing'}`,
    `agent_manifest=${report.agent_manifest_present} governance=${report.governance_catalog_present}`,
  ]
  if (report.findings.length === 0) {
    lines.push('no findings')
    return lines.join('\n')
  }
  for (const f of report.findings) {
    lines.push(`[${f.code}] ${f.surface}: ${f.detail}`)
    if (f.provision) lines.push(`  run: ${f.provision}`)
  }
  return lines.join('\n')
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';

export type ProductionGateStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface ProductionGate {
  id: string;
  title: string;
  status: ProductionGateStatus;
  required: boolean;
  skipped: boolean;
  blocking: boolean;
  evidence_path: string | null;
  message: string;
  next_action: string | null;
}

export interface ProductionBenchmarkReport {
  schema_version: 1;
  benchmark_type: 'babel_cli_production_readiness';
  generated_at: string;
  artifact_path: string;
  environment: {
    platform: NodeJS.Platform;
    node: string;
    babel_root: string;
    runs_dir: string;
  };
  production_claim_scope: string;
  safe_wording: string;
  unsafe_wording: string[];
  skipped_gates: string[];
  summary: {
    gates: number;
    pass: number;
    fail: number;
    warn: number;
    skipped: number;
    required: number;
    blocking_failures: number;
    claim_ready: boolean;
  };
  gates: ProductionGate[];
  blocking_failures: string[];
  next_actions: string[];
}

export interface ProductionBenchmarkOptions {
  outputDir?: string;
  now?: Date;
  proofRoot?: string;
  statusRoot?: string;
  packageJsonPath?: string;
  skipGateIds?: string[];
}

const ProofStatusSchema = z
  .object({
    status: z.enum(['pass', 'partial', 'fail']),
  })
  .passthrough();

const SubagentPluginProofEntrySchema = z
  .object({
    status: z.enum(['pass', 'partial', 'fail']),
  })
  .passthrough();

const SubagentPluginPublicProofSchema = z
  .object({
    schema_version: z.number(),
    artifact_type: z.string(),
    status: z.enum(['pass', 'partial', 'fail']),
    subagents: z
      .object({
        readonly: SubagentPluginProofEntrySchema,
      })
      .passthrough(),
    plugins: z
      .object({
        strict: SubagentPluginProofEntrySchema,
      })
      .passthrough(),
    public_export: z
      .object({
        strict: SubagentPluginProofEntrySchema,
      })
      .passthrough(),
  })
  .passthrough();

const VerifierRollbackProofSchema = z
  .object({
    verifier_universality: z
      .object({
        status: z.enum(['pass', 'partial', 'fail']),
      })
      .passthrough(),
    hostile_rollback_corpus: z
      .object({
        status: z.enum(['pass', 'partial', 'fail']),
      })
      .passthrough(),
  })
  .passthrough();

function toArtifactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function readJsonIfExists(path: string): unknown | null {
  const text = readTextIfExists(path);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function statusToGateStatus(status: 'pass' | 'partial' | 'fail'): ProductionGateStatus {
  return status === 'pass' ? 'pass' : status === 'partial' ? 'warn' : 'fail';
}

function makeGate(input: Omit<ProductionGate, 'blocking'>): ProductionGate {
  return {
    ...input,
    blocking:
      !input.skipped && input.required && input.status !== 'pass' && input.status !== 'skip',
  };
}

function textGate(input: {
  id: string;
  title: string;
  path: string;
  required: boolean;
  skipped: boolean;
  requiredText: string[];
  message: string;
  nextAction: string;
}): ProductionGate {
  const text = readTextIfExists(input.path);
  const exists = existsSync(input.path);
  if (input.skipped) {
    return makeGate({
      ...input,
      status: 'skip',
      required: input.required,
      skipped: true,
      evidence_path: exists ? input.path : null,
      message: `Gate skipped in report options for safety reasons (${input.id}).`,
      next_action: null,
    });
  }
  if (!exists && !input.required) {
    return makeGate({
      ...input,
      status: 'skip',
      required: false,
      skipped: true,
      evidence_path: null,
      message: `Gate is optional and has no evidence artifact yet (${input.id}).`,
      next_action: input.nextAction,
    });
  }
  const matched = Boolean(text) && input.requiredText.every((pattern) => text!.includes(pattern));
  return makeGate({
    id: input.id,
    title: input.title,
    status: matched ? 'pass' : 'fail',
    required: input.required,
    evidence_path: exists ? input.path : null,
    skipped: false,
    message: matched ? input.message : `Missing required evidence text in ${input.path}.`,
    next_action: matched ? null : input.nextAction,
  });
}

function proofStatusGate(input: {
  id: string;
  title: string;
  path: string;
  required: boolean;
  skipped: boolean;
  message: string;
  nextAction: string;
}): ProductionGate {
  const exists = existsSync(input.path);
  if (input.skipped) {
    return makeGate({
      ...input,
      status: 'skip',
      required: input.required,
      skipped: true,
      evidence_path: exists ? input.path : null,
      message: `Gate skipped in report options for safety reasons (${input.id}).`,
      next_action: null,
    });
  }
  if (!exists && !input.required) {
    return makeGate({
      ...input,
      status: 'skip',
      required: false,
      skipped: true,
      evidence_path: null,
      message: `Optional evidence artifact not present for ${input.id}.`,
      next_action: input.nextAction,
    });
  }
  const parsed = ProofStatusSchema.safeParse(readJsonIfExists(input.path));
  if (!parsed.success) {
    return makeGate({
      id: input.id,
      title: input.title,
      status: 'fail',
      required: input.required,
      evidence_path: exists ? input.path : null,
      skipped: false,
      message: `Missing or invalid production proof artifact: ${input.path}.`,
      next_action: input.nextAction,
    });
  }

  const status = statusToGateStatus(parsed.data.status);
  return makeGate({
    id: input.id,
    title: input.title,
    status,
    required: input.required,
    skipped: false,
    evidence_path: input.path,
    message:
      status === 'pass' ? input.message : `Production proof artifact is ${parsed.data.status}.`,
    next_action: status === 'pass' ? null : input.nextAction,
  });
}

function subagentPluginPublicProofGate(input: {
  id: string;
  title: string;
  path: string;
  required: boolean;
  skipped: boolean;
  nextAction: string;
}): ProductionGate {
  const exists = existsSync(input.path);
  if (input.skipped) {
    return makeGate({
      ...input,
      status: 'skip',
      required: input.required,
      skipped: true,
      evidence_path: exists ? input.path : null,
      message: `Gate skipped in report options for safety reasons (${input.id}).`,
      next_action: null,
    });
  }
  if (!exists && !input.required) {
    return makeGate({
      ...input,
      status: 'skip',
      required: false,
      skipped: true,
      evidence_path: null,
      message: `Optional evidence artifact not present for ${input.id}.`,
      next_action: input.nextAction,
    });
  }

  const parsed = SubagentPluginPublicProofSchema.safeParse(readJsonIfExists(input.path));
  if (!parsed.success) {
    return makeGate({
      id: input.id,
      title: input.title,
      status: 'fail',
      required: input.required,
      evidence_path: exists ? input.path : null,
      skipped: false,
      message: `Missing or invalid production proof artifact: ${input.path}.`,
      next_action: input.nextAction,
    });
  }

  const readonlyStatus = parsed.data.subagents.readonly.status;
  const pluginStatus = parsed.data.plugins.strict.status;
  const publicStatus = parsed.data.public_export.strict.status;
  const missingRequirements: string[] = [];
  if (readonlyStatus !== 'pass') {
    missingRequirements.push('subagent readonly proof');
  }
  if (pluginStatus !== 'pass') {
    missingRequirements.push('plugin strict proof');
  }
  if (publicStatus !== 'pass') {
    missingRequirements.push('public strict scrub proof');
  }

  const status =
    missingRequirements.length === 0
      ? 'pass'
      : [readonlyStatus, pluginStatus, publicStatus].some((entry) => entry === 'fail')
        ? 'fail'
        : 'warn';
  return makeGate({
    id: input.id,
    title: input.title,
    status,
    required: input.required,
    skipped: false,
    evidence_path: input.path,
    message:
      status === 'pass'
        ? 'Subagent/plugin/public strict proof is claim-ready for scoped production.'
        : `Required proof is incomplete: ${missingRequirements.join(', ')}.`,
    next_action: status === 'pass' ? null : input.nextAction,
  });
}

function verifierRollbackGates(
  path: string,
  options: { skipGateIds: Set<string> },
): ProductionGate[] {
  const parsed = VerifierRollbackProofSchema.safeParse(readJsonIfExists(path));
  const isSkipped =
    options.skipGateIds.has('required_verifier_universality') ||
    options.skipGateIds.has('hostile_rollback_corpus');
  if (isSkipped) {
    return [
      makeGate({
        id: 'required_verifier_universality',
        title: 'Required verifier command-path map',
        status: 'skip',
        required: false,
        skipped: true,
        evidence_path: existsSync(path) ? path : null,
        message: 'Gate intentionally skipped by report options.',
        next_action: null,
      }),
      makeGate({
        id: 'hostile_rollback_corpus',
        title: 'Hostile rollback/worktree corpus',
        status: 'skip',
        required: false,
        skipped: true,
        evidence_path: existsSync(path) ? path : null,
        message: 'Gate intentionally skipped by report options.',
        next_action: null,
      }),
    ];
  }
  if (!parsed.success) {
    return [
      makeGate({
        id: 'required_verifier_universality',
        title: 'Required verifier command-path map',
        status: 'fail',
        required: true,
        skipped: false,
        evidence_path: existsSync(path) ? path : null,
        message: `Missing or invalid verifier/rollback proof artifact: ${path}.`,
        next_action: 'Create verifier command-path proof with every mutating lane classified.',
      }),
      makeGate({
        id: 'hostile_rollback_corpus',
        title: 'Hostile rollback/worktree corpus',
        status: 'fail',
        required: true,
        skipped: false,
        evidence_path: existsSync(path) ? path : null,
        message: `Missing or invalid verifier/rollback proof artifact: ${path}.`,
        next_action:
          'Create hostile rollback proof for dirty targets, generated files, nested dirs, drift, and rollback failure.',
      }),
    ];
  }

  return [
    makeGate({
      id: 'required_verifier_universality',
      title: 'Required verifier command-path map',
      status: statusToGateStatus(parsed.data.verifier_universality.status),
      required: true,
      skipped: false,
      evidence_path: path,
      message: 'Verifier command-path matrix exists and is claim-ready for scoped production.',
      next_action:
        parsed.data.verifier_universality.status === 'pass'
          ? null
          : 'Close every partial/fail verifier path before production wording changes.',
    }),
    makeGate({
      id: 'hostile_rollback_corpus',
      title: 'Hostile rollback/worktree corpus',
      status: statusToGateStatus(parsed.data.hostile_rollback_corpus.status),
      required: true,
      skipped: false,
      evidence_path: path,
      message: 'Hostile rollback corpus exists and is claim-ready for scoped production.',
      next_action:
        parsed.data.hostile_rollback_corpus.status === 'pass'
          ? null
          : 'Close every partial/fail rollback scenario before production wording changes.',
    }),
  ];
}

function scriptGate(input: {
  packageJsonPath: string;
  required: boolean;
  skipped: boolean;
}): ProductionGate {
  if (input.skipped) {
    const exists = existsSync(input.packageJsonPath);
    return makeGate({
      id: 'deepseek_required_script',
      title: 'Required DeepSeek live-governance script',
      status: 'skip',
      required: input.required,
      skipped: true,
      evidence_path: exists ? input.packageJsonPath : null,
      message: 'Gate skipped in report options for safety reasons (deepseek_required_script).',
      next_action: null,
    });
  }
  const text = readTextIfExists(input.packageJsonPath);
  const matched = Boolean(text) && text!.includes('"test:live-governance:required"');
  return makeGate({
    id: 'deepseek_required_script',
    title: 'Required DeepSeek live-governance script',
    status: matched ? 'pass' : 'fail',
    required: input.required,
    skipped: false,
    evidence_path: existsSync(input.packageJsonPath) ? input.packageJsonPath : null,
    message: matched
      ? 'Package scripts expose a required DeepSeek live-governance lane.'
      : 'Package scripts do not expose test:live-governance:required.',
    next_action: matched
      ? null
      : 'Add test:live-governance:required and make it fail when DEEPSEEK_API_KEY is absent.',
  });
}

function buildGates(input: {
  proofRoot: string;
  statusRoot: string;
  packageJsonPath: string;
  skipGateIds: Set<string>;
}): ProductionGate[] {
  const roadmapPath = join(input.statusRoot, 'BABEL_ROADMAP_REMAINING_PROOF_PLAN_2026-06-05.md');
  const p8Path = join(input.statusRoot, 'BABEL_P8_P11_IMPLEMENTATION_EVIDENCE_2026-06-05.md');
  const publicPath = join(input.statusRoot, 'BABEL_PUBLIC_EXPORT_PROOF_2026-06-05.md');
  const livePath = join(input.proofRoot, 'live-governance-breadth-proof.json');
  const verifierRollbackPath = join(input.proofRoot, 'verifier-rollback-proof.json');
  const subagentPluginPath = join(input.proofRoot, 'subagent-plugin-public-proof.json');

  return [
    textGate({
      id: 'core_local_validation',
      title: 'Core local validation evidence',
      path: p8Path,
      required: true,
      skipped: input.skipGateIds.has('core_local_validation'),
      requiredText: [
        'npm --prefix .\\babel-cli run typecheck',
        'npm --prefix .\\babel-cli run build',
        'npm --prefix .\\babel-cli run test:unit',
      ],
      message: 'Core validation evidence names typecheck, build, and unit coverage.',
      nextAction:
        'Refresh P8-P11 or production-proof validation evidence with typecheck, build, and unit results.',
    }),
    textGate({
      id: 'catalog_and_public_release',
      title: 'Catalog and public-release validation evidence',
      path: publicPath,
      required: true,
      skipped: input.skipGateIds.has('catalog_and_public_release'),
      requiredText: [
        'validate-catalog.ps1',
        'scrub checker pass/fail boundary',
        'test:public-release',
      ],
      message: 'Public export validation evidence exists.',
      nextAction: 'Run public-release validation and save strict scrub evidence.',
    }),
    textGate({
      id: 'doctor_and_product_benchmark',
      title: 'Doctor-all and product benchmark evidence',
      path: roadmapPath,
      required: true,
      skipped: input.skipGateIds.has('doctor_and_product_benchmark'),
      requiredText: [
        'doctor --scope all --json` is non-red',
        'benchmark product --json` is green at `27/27`',
      ],
      message: 'Doctor-all and product benchmark are non-red in current roadmap evidence.',
      nextAction: 'Refresh roadmap evidence after doctor-all and product benchmark pass.',
    }),
    scriptGate({
      packageJsonPath: input.packageJsonPath,
      required: true,
      skipped: input.skipGateIds.has('deepseek_required_script'),
    }),
    proofStatusGate({
      id: 'live_governance_breadth',
      title: 'DeepSeek live governance breadth',
      path: livePath,
      required: true,
      skipped: input.skipGateIds.has('live_governance_breadth'),
      message: 'DeepSeek live governance breadth proof is claim-ready.',
      nextAction: 'Run required DeepSeek live governance breadth and save sanitized evidence.',
    }),
    ...verifierRollbackGates(verifierRollbackPath, { skipGateIds: input.skipGateIds }),
    subagentPluginPublicProofGate({
      id: 'subagent_plugin_public_strict',
      title: 'Subagent, plugin, and public strict proof',
      path: subagentPluginPath,
      required: true,
      skipped: input.skipGateIds.has('subagent_plugin_public_strict'),
      nextAction: 'Close subagent live opt-in, plugin strict, and public scrub proof gaps.',
    }),
  ];
}

function summarize(gates: ProductionGate[]): ProductionBenchmarkReport['summary'] {
  const pass = gates.filter((gate) => gate.status === 'pass').length;
  const fail = gates.filter((gate) => gate.status === 'fail').length;
  const warn = gates.filter((gate) => gate.status === 'warn').length;
  const skipped = gates.filter((gate) => gate.status === 'skip').length;
  const required = gates.filter((gate) => gate.required).length;
  const blockingFailures = gates.filter((gate) => gate.blocking).length;
  return {
    gates: gates.length,
    pass,
    fail,
    warn,
    skipped,
    required,
    blocking_failures: blockingFailures,
    claim_ready: blockingFailures === 0 && skipped === 0,
  };
}

export function runProductionBenchmark(
  options: ProductionBenchmarkOptions = {},
): ProductionBenchmarkReport {
  const now = options.now ?? new Date();
  const outputDir = resolve(options.outputDir ?? join(BABEL_RUNS_DIR, 'benchmarks'));
  const artifactPath = join(outputDir, `production-readiness-${toArtifactTimestamp(now)}.json`);
  const proofRoot = resolve(
    options.proofRoot ?? join(BABEL_ROOT, 'docs', 'status', 'production-proof'),
  );
  const statusRoot = resolve(options.statusRoot ?? join(BABEL_ROOT, 'docs', 'status'));
  const packageJsonPath = resolve(
    options.packageJsonPath ?? join(BABEL_ROOT, 'babel-cli', 'package.json'),
  );
  const skipGateIds = new Set(options.skipGateIds ?? []);
  const gates = buildGates({ proofRoot, statusRoot, packageJsonPath, skipGateIds });
  const summary = summarize(gates);
  const blockingFailures = gates.filter((gate) => gate.blocking).map((gate) => gate.id);
  const skippedGates = gates.filter((gate) => gate.skipped).map((gate) => gate.id);

  mkdirSync(outputDir, { recursive: true });
  const report: ProductionBenchmarkReport = {
    schema_version: 1,
    benchmark_type: 'babel_cli_production_readiness',
    generated_at: now.toISOString(),
    artifact_path: artifactPath,
    environment: {
      platform: process.platform,
      node: process.version,
      babel_root: BABEL_ROOT,
      runs_dir: BABEL_RUNS_DIR,
    },
    production_claim_scope: 'DeepSeek-backed autonomous Coding Agent CLI lane',
    safe_wording: summary.claim_ready
      ? 'Babel is production-ready for the proven DeepSeek-backed autonomous Coding Agent CLI lane, with provider-agnostic, market-parity, and mutating live-subagent claims excluded.'
      : 'Babel is an autonomous Coding Agent CLI with optional governed pipeline mode; some production-proof gates are still open.',
    unsafe_wording: [
      'provider-agnostic production AI control plane',
      'market parity with other coding agents',
      'safe live autonomous parallel coding agents',
      'universal mandatory verifiers across every command path',
    ],
    summary,
    gates,
    skipped_gates: skippedGates,
    blocking_failures: blockingFailures,
    next_actions: summary.claim_ready
      ? [
          'Update claims matrix only to the scoped DeepSeek-backed production wording and keep exclusions visible.',
        ]
      : gates
          .filter((gate) => gate.blocking)
          .map((gate) => gate.next_action ?? `Close gate ${gate.id}.`),
  };
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function formatProductionBenchmarkHuman(report: ProductionBenchmarkReport): string {
  return [
    'Babel Production Readiness Benchmark',
    `Artifact: ${report.artifact_path}`,
    `Generated: ${report.generated_at}`,
    `Scope: ${report.production_claim_scope}`,
    '',
    `Claim ready: ${report.summary.claim_ready ? 'yes' : 'no'}`,
    `Gates: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    `Blocking failures: ${report.summary.blocking_failures}`,
    '',
    'Safe wording:',
    report.safe_wording,
    '',
    'Gates:',
    ...report.gates.map(
      (gate) => `${gate.status.toUpperCase().padEnd(4)} ${gate.id} - ${gate.message}`,
    ),
  ].join('\n');
}

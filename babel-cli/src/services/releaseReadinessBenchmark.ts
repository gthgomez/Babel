import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';

export type ReadinessStatus = 'pass' | 'fail';

export interface ReleaseReadinessGate {
  readonly id: string;
  readonly category: 'catalog' | 'privacy' | 'independence' | 'build';
  readonly status: ReadinessStatus;
  readonly exit_code: number;
}

export interface ReleaseReadinessReport {
  readonly schema_version: 2;
  readonly benchmark_type: 'babel_cli_release_readiness';
  readonly generated_at: string;
  readonly artifact_path: string;
  readonly claim_status: 'release_checks_passed' | 'release_checks_blocked';
  readonly summary: {
    readonly gates: number;
    readonly pass: number;
    readonly fail: number;
  };
  readonly gates: readonly ReleaseReadinessGate[];
}

interface GateDefinition {
  readonly id: string;
  readonly category: ReleaseReadinessGate['category'];
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ReleaseReadinessBenchmarkOptions {
  readonly now?: Date;
  readonly outputDir?: string;
  readonly gateRunner?: (gate: GateDefinition) => { exitCode: number };
}

function toArtifactTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function publicArtifactPath(path: string): string {
  const candidate = relative(BABEL_ROOT, path).replaceAll('\\', '/');
  if (candidate && !candidate.startsWith('../') && candidate !== '..') {
    return candidate;
  }
  return `<external-output>/${basename(path)}`;
}

function defaultGateRunner(gate: GateDefinition): { exitCode: number } {
  const result = spawnSync(gate.executable, [...gate.args], {
    cwd: gate.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  return { exitCode: result.status ?? 1 };
}

function gateDefinitions(): GateDefinition[] {
  const toolsRoot = join(BABEL_ROOT, 'tools');
  const cliRoot = join(BABEL_ROOT, 'babel-cli');
  const ps = (script: string, ...args: string[]): GateDefinition['args'] => [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(toolsRoot, script),
    ...args,
  ];
  return [
    { id: 'catalog', category: 'catalog', executable: 'pwsh', args: ps('validate-catalog.ps1'), cwd: BABEL_ROOT },
    { id: 'public_scrub', category: 'privacy', executable: 'pwsh', args: ps('check-public-scrub.ps1', '-RepoRoot', BABEL_ROOT, '-Strict'), cwd: BABEL_ROOT },
    { id: 'public_content_policy', category: 'privacy', executable: 'pwsh', args: ps('check-public-content-policy.ps1', '-RepoRoot', BABEL_ROOT), cwd: BABEL_ROOT },
    { id: 'canonical_independence', category: 'independence', executable: 'pwsh', args: ps('check-canonical-independence.ps1', '-RepoRoot', BABEL_ROOT), cwd: BABEL_ROOT },
    process.platform === 'win32'
      ? { id: 'typecheck', category: 'build', executable: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm run typecheck'], cwd: cliRoot }
      : { id: 'typecheck', category: 'build', executable: 'npm', args: ['run', 'typecheck'], cwd: cliRoot },
  ];
}

export function runReleaseReadinessBenchmark(
  options: ReleaseReadinessBenchmarkOptions = {},
): ReleaseReadinessReport {
  const now = options.now ?? new Date();
  const outputDir = resolve(options.outputDir ?? join(BABEL_RUNS_DIR, 'benchmarks'));
  const artifactFile = join(outputDir, `release-readiness-${toArtifactTimestamp(now)}.json`);
  const runner = options.gateRunner ?? defaultGateRunner;
  const gates = gateDefinitions().map((definition): ReleaseReadinessGate => {
    const result = runner(definition);
    return {
      id: definition.id,
      category: definition.category,
      status: result.exitCode === 0 ? 'pass' : 'fail',
      exit_code: result.exitCode,
    };
  });
  const pass = gates.filter((gate) => gate.status === 'pass').length;
  const fail = gates.length - pass;
  const report: ReleaseReadinessReport = {
    schema_version: 2,
    benchmark_type: 'babel_cli_release_readiness',
    generated_at: now.toISOString(),
    artifact_path: publicArtifactPath(artifactFile),
    claim_status: fail === 0 ? 'release_checks_passed' : 'release_checks_blocked',
    summary: { gates: gates.length, pass, fail },
    gates,
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(artifactFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function formatReleaseReadinessBenchmarkHuman(report: ReleaseReadinessReport): string {
  return [
    'Babel Release Readiness',
    `Artifact: ${report.artifact_path}`,
    `Claim status: ${report.claim_status}`,
    `Gates: ${report.summary.pass} pass, ${report.summary.fail} fail`,
    '',
    ...report.gates.map((gate) => `${gate.status.toUpperCase().padEnd(4)} ${gate.id}`),
  ].join('\n');
}

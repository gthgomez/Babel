import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { runDocsAudit, type DocsAuditReport } from './docsFitness.js';
import {
  MaintenanceAuditReportSchema,
  type MaintenanceAuditReport,
  type MaintenanceFinding,
  type MaintenanceFindingCategory,
  type MaintenanceMetric,
  type RunMaintenanceAuditOptions,
} from './maintenanceAuditContracts.js';

export {
  MaintenanceAuditReportSchema,
  MaintenanceFindingCategorySchema,
  MaintenanceFindingSchema,
  MaintenanceMetricSchema,
  type MaintenanceAuditReport,
  type MaintenanceFinding,
  type MaintenanceFindingCategory,
  type MaintenanceMetric,
  type RunMaintenanceAuditOptions,
  type WriteMaintenanceAuditOptions,
} from './maintenanceAuditContracts.js';
export {
  formatMaintenanceAuditHuman,
  writeMaintenanceAuditReport,
} from './maintenanceAuditOutput.js';

interface SourceFileMetric {
  path: string;
  absolutePath: string;
  lines: number;
  fanin: number;
  fanout: number;
}

interface SourceProvenanceResult {
  status: 'pass' | 'fail';
  unexpected: string[];
  missing: string[];
  allowed: string[];
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.js']);
const DOC_EXTENSIONS = new Set(['.md']);

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function toRelative(root: string, filePath: string): string {
  return normalizeRelative(relative(root, filePath));
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

function readText(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function lineCount(filePath: string): number {
  const text = readText(filePath);
  return text === null || text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function gitLines(root: string, args: string[]): string[] {
  try {
    const output = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length === 0 ? [] : output.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function walkFiles(root: string, relRoot: string): string[] {
  const fullRoot = resolve(root, relRoot);
  if (!existsSync(fullRoot)) {
    return [];
  }
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const relPath = toRelative(root, fullPath);
      if (entry.isDirectory()) {
        if (
          ['.git', 'node_modules', 'dist', 'runs', 'artifacts', '.pytest_cache'].includes(
            entry.name,
          )
        ) {
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (entry.isFile()) {
        out.push(relPath);
      }
    }
  };
  visit(fullRoot);
  return out.sort();
}

function extensionOf(path: string): string {
  const match = /\.[^.\\/]+$/.exec(path);
  return match?.[0]?.toLowerCase() ?? '';
}

function collectScanFiles(
  root: string,
  options: RunMaintenanceAuditOptions,
): { mode: 'changed' | 'target' | 'all'; target: string | null; files: string[] } {
  if (options.all === true) {
    return {
      mode: 'all',
      target: null,
      files: [...walkFiles(root, 'babel-cli/src'), ...walkFiles(root, 'docs')].filter(
        (path) => SOURCE_EXTENSIONS.has(extensionOf(path)) || DOC_EXTENSIONS.has(extensionOf(path)),
      ),
    };
  }

  if (options.target) {
    const targetPath = isAbsolute(options.target)
      ? resolve(options.target)
      : resolve(root, options.target);
    if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      return {
        mode: 'target',
        target: normalizeRelative(options.target),
        files: walkFiles(root, toRelative(root, targetPath)).filter(
          (path) =>
            SOURCE_EXTENSIONS.has(extensionOf(path)) || DOC_EXTENSIONS.has(extensionOf(path)),
        ),
      };
    }
    return {
      mode: 'target',
      target: normalizeRelative(options.target),
      files: isInside(root, targetPath) ? [toRelative(root, targetPath)] : [],
    };
  }

  const changed = gitLines(root, ['diff', '--name-only', 'HEAD', '--', 'babel-cli/src', 'docs']);
  return {
    mode: 'changed',
    target: null,
    files: changed.filter(
      (path) => SOURCE_EXTENSIONS.has(extensionOf(path)) || DOC_EXTENSIONS.has(extensionOf(path)),
    ),
  };
}

function parseRelativeImports(root: string, filePath: string): string[] {
  const text = readText(filePath);
  if (text === null) {
    return [];
  }
  const deps = new Set<string>();
  const regex =
    /(?:import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?from\s+|await\s+import\()\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const spec = match[1];
    if (!spec || !spec.startsWith('.')) {
      continue;
    }
    const resolved = resolveImportCandidate(dirname(filePath), spec);
    if (resolved && isInside(join(root, 'babel-cli', 'src'), resolved)) {
      deps.add(resolved);
    }
  }
  return Array.from(deps);
}

function resolveImportCandidate(baseDir: string, spec: string): string | null {
  const raw = resolve(baseDir, spec);
  const withoutJs = raw.endsWith('.js') ? raw.slice(0, -3) : raw;
  const candidates = [
    raw,
    `${withoutJs}.ts`,
    `${withoutJs}.js`,
    `${raw}.ts`,
    `${raw}.js`,
    join(raw, 'index.ts'),
    join(raw, 'index.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function buildSourceMetrics(root: string): SourceFileMetric[] {
  const sourceRoot = join(root, 'babel-cli', 'src');
  const files = walkFiles(root, 'babel-cli/src')
    .filter((path) => SOURCE_EXTENSIONS.has(extensionOf(path)))
    .map((path) => resolve(root, path));
  const fanin = new Map<string, number>();
  const fanout = new Map<string, number>();
  for (const file of files) {
    const deps = parseRelativeImports(root, file);
    fanout.set(file, deps.length);
    for (const dep of deps) {
      fanin.set(dep, (fanin.get(dep) ?? 0) + 1);
    }
  }
  return files
    .filter((file) => isInside(sourceRoot, file))
    .map((file) => ({
      path: toRelative(root, file),
      absolutePath: file,
      lines: lineCount(file),
      fanin: fanin.get(file) ?? 0,
      fanout: fanout.get(file) ?? 0,
    }))
    .sort((a, b) => b.lines - a.lines);
}

function readSourceProvenance(root: string): SourceProvenanceResult {
  const provenancePath = join(root, 'babel-cli', 'source-provenance.json');
  const srcRoot = join(root, 'babel-cli', 'src');
  const actual = walkFiles(root, 'babel-cli/src')
    .filter((path) => path.endsWith('.js'))
    .map((path) => normalizeRelative(relative(join(root, 'babel-cli'), resolve(root, path))))
    .sort();
  let allowed: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(provenancePath, 'utf8')) as {
      allowed_js_source_files?: unknown;
    };
    allowed = Array.isArray(parsed.allowed_js_source_files)
      ? parsed.allowed_js_source_files
          .filter((entry): entry is string => typeof entry === 'string')
          .map(normalizeRelative)
      : [];
  } catch {
    allowed = [];
  }
  const allowedSet = new Set(allowed);
  const unexpected = actual.filter((path) => !allowedSet.has(path));
  const actualSet = new Set(actual);
  const missing = allowed.filter((path) => !actualSet.has(path));
  void srcRoot;
  return {
    status: unexpected.length > 0 || missing.length > 0 ? 'fail' : 'pass',
    unexpected,
    missing,
    allowed,
  };
}

function addFinding(findings: MaintenanceFinding[], finding: MaintenanceFinding): void {
  findings.push(finding);
}

function addSourceMetricFindings(
  findings: MaintenanceFinding[],
  metrics: SourceFileMetric[],
  scanSet: Set<string>,
): void {
  for (const metric of metrics) {
    const inScan = scanSet.size === 0 || scanSet.has(metric.path);
    if (!inScan) {
      continue;
    }
    if (metric.lines > 1_000) {
      addFinding(findings, {
        severity: 'warn',
        category: 'oversized_file',
        path: metric.path,
        evidence: `${metric.lines} lines`,
        suggested_action: 'Split by ownership boundary while preserving compatibility exports.',
        safe_to_apply: false,
        source: 'source-metrics',
      });
    } else if (metric.lines > 500) {
      addFinding(findings, {
        severity: 'info',
        category: 'oversized_file',
        path: metric.path,
        evidence: `${metric.lines} lines`,
        suggested_action: 'Review for extraction candidates before adding more responsibilities.',
        safe_to_apply: false,
        source: 'source-metrics',
      });
    }
    if (metric.fanout > 20 || metric.fanin > 10) {
      addFinding(findings, {
        severity: 'warn',
        category: 'high_coupling',
        path: metric.path,
        evidence: `fanin ${metric.fanin}, fanout ${metric.fanout}`,
        suggested_action:
          'Introduce a smaller facade or move shared contracts to a narrower module.',
        safe_to_apply: false,
        source: 'import-graph',
      });
    }
  }
}

function addDocsFindings(findings: MaintenanceFinding[], docsAudit: DocsAuditReport): void {
  for (const finding of docsAudit.findings.slice(0, 25)) {
    const category: MaintenanceFindingCategory = finding.code.startsWith('link.')
      ? 'broken_link'
      : 'stale_doc';
    addFinding(findings, {
      severity: finding.severity,
      category,
      path: finding.path ?? null,
      evidence: `${finding.code}${finding.line ? `:${finding.line}` : ''} - ${finding.message}`,
      suggested_action:
        category === 'broken_link'
          ? 'Fix the link or classify the document as generated/historical in the docs manifest.'
          : 'Update the docs manifest or refresh the stale documentation.',
      safe_to_apply: category === 'broken_link',
      source: 'docs-audit',
    });
  }
}

function addProvenanceFindings(
  findings: MaintenanceFinding[],
  provenance: SourceProvenanceResult,
): void {
  for (const path of provenance.unexpected) {
    addFinding(findings, {
      severity: 'error',
      category:
        path.includes('/scratch/') || basename(path) === 'math.js'
          ? 'fixture_leak'
          : 'js_provenance',
      path: `babel-cli/${path}`,
      evidence: 'JS source file is not listed in source-provenance.json.',
      suggested_action:
        'Move fixture/scratch code out of src or add a justified provenance entry for real JS source.',
      safe_to_apply: basename(path) === 'math.js' || path.includes('/scratch/'),
      source: 'source-provenance',
    });
  }
  for (const path of provenance.missing) {
    addFinding(findings, {
      severity: 'warn',
      category: 'js_provenance',
      path: `babel-cli/${path}`,
      evidence: 'source-provenance.json lists a JS source file that no longer exists.',
      suggested_action:
        'Remove the stale provenance entry after confirming the file was intentionally migrated.',
      safe_to_apply: true,
      source: 'source-provenance',
    });
  }
}

function addFixtureLeakFindings(findings: MaintenanceFinding[], root: string): void {
  const candidates = ['babel-cli/src/math.js', 'babel-cli/src/scratch/test_indexer.ts'];
  for (const path of candidates) {
    if (!existsSync(join(root, path))) {
      continue;
    }
    addFinding(findings, {
      severity: 'warn',
      category: 'fixture_leak',
      path,
      evidence: 'Fixture or manual probe code is tracked under production src.',
      suggested_action: 'Move it to fixtures/scripts or delete it if no command imports it.',
      safe_to_apply: true,
      source: 'fixture-scan',
    });
  }
}

function addDuplicateFindings(findings: MaintenanceFinding[], root: string): void {
  const files = [
    ...walkFiles(root, 'docs'),
    ...walkFiles(root, '02_Skills'),
    ...walkFiles(root, 'archive'),
  ].filter((path) => DOC_EXTENSIONS.has(extensionOf(path)));
  const groups = new Map<string, string[]>();
  for (const path of files) {
    const fullPath = join(root, path);
    const text = readText(fullPath);
    if (text === null || text.length < 2_000) {
      continue;
    }
    const hash = createHash('sha256').update(text).digest('hex');
    const group = groups.get(hash) ?? [];
    group.push(path);
    groups.set(hash, group);
  }
  for (const group of Array.from(groups.values())
    .filter((paths) => paths.length > 1)
    .slice(0, 5)) {
    addFinding(findings, {
      severity: 'info',
      category: 'duplicate_content',
      path: group[0] ?? null,
      evidence: `Exact duplicate content also appears in ${group.slice(1).join(', ')}`,
      suggested_action:
        'Classify one copy as historical/archive or replace duplicate content with a pointer.',
      safe_to_apply: false,
      source: 'content-hash',
    });
  }
}

function addDirtyTreeFinding(findings: MaintenanceFinding[], statusEntries: string[]): void {
  if (statusEntries.length === 0) {
    return;
  }
  addFinding(findings, {
    severity: 'warn',
    category: 'dirty_tree_risk',
    path: null,
    evidence: `${statusEntries.length} git status entries are present.`,
    suggested_action:
      'Separate intended feature work from cleanup before applying broad simplification edits.',
    safe_to_apply: false,
    source: 'git-status',
  });
}

function buildMetrics(
  sourceMetrics: SourceFileMetric[],
  docsAudit: DocsAuditReport,
  provenance: SourceProvenanceResult,
): MaintenanceMetric[] {
  const over500 = sourceMetrics.filter((metric) => metric.lines > 500).length;
  const over1000 = sourceMetrics.filter((metric) => metric.lines > 1_000).length;
  return [
    { name: 'source_files', value: sourceMetrics.length },
    {
      name: 'source_lines',
      value: sourceMetrics.reduce((sum, metric) => sum + metric.lines, 0),
      unit: 'lines',
    },
    { name: 'source_files_over_500_lines', value: over500 },
    { name: 'source_files_over_1000_lines', value: over1000 },
    { name: 'docs_checked', value: docsAudit.summary.checkedDocs },
    { name: 'docs_audit_errors', value: docsAudit.summary.errors },
    { name: 'docs_audit_warnings', value: docsAudit.summary.warnings },
    { name: 'js_provenance_unexpected', value: provenance.unexpected.length },
  ];
}

function statusFromFindings(findings: MaintenanceFinding[]): 'pass' | 'warn' | 'fail' {
  if (findings.some((finding) => finding.severity === 'error')) {
    return 'fail';
  }
  if (findings.some((finding) => finding.severity === 'warn')) {
    return 'warn';
  }
  return 'pass';
}

function nextAction(findings: MaintenanceFinding[]): string {
  const safe = findings.find((finding) => finding.safe_to_apply);
  if (safe) {
    return safe.suggested_action;
  }
  const highCoupling = findings.find(
    (finding) => finding.category === 'high_coupling' || finding.category === 'oversized_file',
  );
  if (highCoupling) {
    return 'Start with a behavior-preserving split plan for the highest-coupling file.';
  }
  return 'Keep the maintenance audit in the regular verification loop.';
}

export function runMaintenanceAudit(options: RunMaintenanceAuditOptions): MaintenanceAuditReport {
  const repoRoot = resolve(options.repoRoot);
  const scan = collectScanFiles(repoRoot, options);
  const scanSet = new Set(scan.files);
  const docsAudit = runDocsAudit({ root: repoRoot });
  const sourceMetrics = buildSourceMetrics(repoRoot);
  const provenance = readSourceProvenance(repoRoot);
  const gitStatus = gitLines(repoRoot, ['status', '--short', '--untracked-files=all']);
  const findings: MaintenanceFinding[] = [];

  addSourceMetricFindings(findings, sourceMetrics, scanSet);
  addDocsFindings(findings, docsAudit);
  addProvenanceFindings(findings, provenance);
  addFixtureLeakFindings(findings, repoRoot);
  addDuplicateFindings(findings, repoRoot);
  addDirtyTreeFinding(findings, gitStatus);

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warn').length;
  const info = findings.filter((finding) => finding.severity === 'info').length;
  const report: MaintenanceAuditReport = {
    schema_version: 1,
    status: statusFromFindings(findings),
    generated_at: new Date().toISOString(),
    repo_root: repoRoot,
    scan: {
      mode: scan.mode,
      target: scan.target,
      files_scanned: scan.files.length,
    },
    summary: {
      total_findings: findings.length,
      errors,
      warnings,
      info,
      next: nextAction(findings),
    },
    metrics: buildMetrics(sourceMetrics, docsAudit, provenance),
    findings,
    proof: {
      no_model_call: true,
      docs_audit_status: docsAudit.status,
      docs_audit_errors: docsAudit.summary.errors,
      docs_audit_warnings: docsAudit.summary.warnings,
      source_provenance_status: provenance.status,
      git_status_entries: gitStatus.length,
    },
    artifacts: {
      report_json: null,
      report_markdown: null,
    },
  };
  return MaintenanceAuditReportSchema.parse(report);
}

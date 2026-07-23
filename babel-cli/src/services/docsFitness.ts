import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export type DocsFindingSeverity = 'error' | 'warn' | 'info';
export type ManifestState = 'missing' | 'present' | 'invalid';

export interface DocsAuditFinding {
  code: string;
  severity: DocsFindingSeverity;
  message: string;
  path?: string;
  line?: number;
}

export interface CheckedDoc {
  path: string;
  classification: string;
  source: 'manifest' | 'discovered';
  lineCount: number;
}

export interface LineBudgetEntry {
  path: string;
  lineCount: number;
  maxLines: number;
  status: 'pass' | 'warn';
  justification: boolean;
}

export interface DocsAuditReport {
  status: 'pass' | 'warn' | 'fail';
  repoRoot: string;
  manifestStatus: {
    state: ManifestState;
    path: string;
  };
  summary: {
    errors: number;
    warnings: number;
    info: number;
    checkedDocs: number;
  };
  findings: DocsAuditFinding[];
  checkedDocs: CheckedDoc[];
  lineBudgetSummary: LineBudgetEntry[];
}

interface TrustedCommandObject {
  command: string;
  source?: string;
  justification?: string;
}

interface DocsManifest {
  schemaVersion?: number;
  lastVerificationDate?: string;
  maintainedDocs: string[];
  historicalDocs: string[];
  generatedEvidence: string[];
  trustedCommands: Array<string | TrustedCommandObject>;
  highRiskPaths: string[];
  doNotUseAsAuthorityGlobs: string[];
  maxLineBudgets: Record<string, number>;
}

const KNOWN_DOCS = [
  'README.md',
  'PROJECT_CONTEXT.md',
  'AGENTS.md',
  'CODEX.md',
  'CLAUDE.md',
  'GEMINI.md',
  'QA_CHECKLIST.md',
  'docs/README.md',
  '.github/copilot-instructions.md',
] as const;

const SKIP_DIRS = new Set([
  '.git',
  '.organization_backup',
  'node_modules',
  'dist',
  'build',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  'reports',
  'release_evidence',
  '.pytest_cache',
]);

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function asRelative(root: string, path: string): string {
  return normalizeRelative(relative(root, path));
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

function addFinding(findings: DocsAuditFinding[], finding: DocsAuditFinding): void {
  findings.push(finding);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseJsonManifest(path: string, findings: DocsAuditFinding[]): DocsManifest | null {
  const raw = readText(path);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('manifest must be a JSON object');
    }
    const record = parsed as Record<string, unknown>;
    const manifest: DocsManifest = {
      maintainedDocs: readStringArray(record['maintainedDocs']),
      historicalDocs: readStringArray(record['historicalDocs']),
      generatedEvidence: readStringArray(record['generatedEvidence']),
      trustedCommands: readTrustedCommands(record['trustedCommands']),
      highRiskPaths: readStringArray(record['highRiskPaths']),
      doNotUseAsAuthorityGlobs: readStringArray(record['doNotUseAsAuthorityGlobs']),
      maxLineBudgets: readLineBudgets(record['maxLineBudgets']),
    };
    if (typeof record['schemaVersion'] === 'number') {
      manifest.schemaVersion = record['schemaVersion'];
    }
    if (typeof record['lastVerificationDate'] === 'string') {
      manifest.lastVerificationDate = record['lastVerificationDate'];
    }
    validateManifestShape(manifest, path, findings);
    return manifest;
  } catch (error: unknown) {
    addFinding(findings, {
      severity: 'error',
      code: 'manifest.invalid_json',
      message: `docs manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      path,
    });
    return null;
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readTrustedCommands(value: unknown): Array<string | TrustedCommandObject> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string | TrustedCommandObject => {
      if (typeof entry === 'string') {
        return true;
      }
      return Boolean(
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>)['command'] === 'string',
      );
    })
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      const record = entry as unknown as Record<string, unknown>;
      const output: TrustedCommandObject = { command: String(record['command']) };
      if (typeof record['source'] === 'string') output.source = record['source'];
      if (typeof record['justification'] === 'string')
        output.justification = record['justification'];
      return output;
    });
}

function readLineBudgets(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const budgets: Record<string, number> = {};
  for (const [key, rawBudget] of Object.entries(value)) {
    if (typeof rawBudget === 'number' && Number.isInteger(rawBudget) && rawBudget > 0) {
      budgets[normalizeRelative(key)] = rawBudget;
    }
  }
  return budgets;
}

function validateManifestShape(
  manifest: DocsManifest,
  manifestPath: string,
  findings: DocsAuditFinding[],
): void {
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    addFinding(findings, {
      severity: 'error',
      code: 'manifest.unsupported_schema',
      message: 'docs manifest schemaVersion must be 1 when present',
      path: manifestPath,
    });
  }
  for (const command of manifest.trustedCommands) {
    if (typeof command !== 'string' && command.source === 'external' && !command.justification) {
      addFinding(findings, {
        severity: 'warn',
        code: 'trusted_command.external_without_justification',
        message: `external trusted command needs justification: ${command.command}`,
        path: manifestPath,
      });
    }
  }
}

function pathFromRepo(root: string, relPath: string): string {
  return resolve(root, normalizeRelative(relPath));
}

function validateManifestPaths(
  root: string,
  manifest: DocsManifest,
  findings: DocsAuditFinding[],
): void {
  const paths = [
    ...manifest.maintainedDocs,
    ...manifest.historicalDocs,
    ...manifest.generatedEvidence.filter((path) => !path.includes('*')),
    ...manifest.highRiskPaths.filter((path) => !path.includes('*')),
  ];
  for (const relPath of paths) {
    const fullPath = pathFromRepo(root, relPath);
    if (!isInside(root, fullPath)) {
      addFinding(findings, {
        severity: 'error',
        code: 'manifest.path_escape',
        message: `manifest path escapes repo root: ${relPath}`,
        path: relPath,
      });
    }
  }
}

function discoverDocs(root: string): string[] {
  const docs = new Set<string>();
  for (const known of KNOWN_DOCS) {
    const fullPath = pathFromRepo(root, known);
    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      docs.add(normalizeRelative(known));
    }
  }
  collectDocs(root, root, docs);
  return Array.from(docs).sort();
}

function collectDocs(root: string, dir: string, docs: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = asRelative(root, fullPath);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      if (relPath.startsWith('artifacts/') || relPath.startsWith('runs/')) {
        continue;
      }
      collectDocs(root, fullPath, docs);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const normalized = normalizeRelative(relPath);
    if (
      normalized.endsWith('.md') ||
      basename(normalized) === 'AGENTS.md' ||
      normalized.endsWith('.instructions.md')
    ) {
      docs.add(normalized);
    }
  }
}

function defaultBudgetFor(relPath: string): number | null {
  const normalized = normalizeRelative(relPath);
  const name = basename(normalized);
  if (normalized === 'AGENTS.md') return 180;
  if (name === 'AGENTS.md') return 120;
  if (name === 'CLAUDE.md') return 200;
  if (name === 'PROJECT_CONTEXT.md') return 500;
  if (name === 'QA_CHECKLIST.md') return 200;
  if (normalized === 'docs/README.md') return 100;
  return null;
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}

function hasBudgetJustification(content: string): boolean {
  return /line budget justification|budget justification|docs budget exception/i.test(content);
}

function checkLineBudgets(
  root: string,
  docs: string[],
  manifest: DocsManifest | null,
  findings: DocsAuditFinding[],
): LineBudgetEntry[] {
  const summary: LineBudgetEntry[] = [];
  for (const relPath of docs) {
    const fullPath = pathFromRepo(root, relPath);
    const content = readText(fullPath);
    if (content === null) {
      continue;
    }
    const maxLines =
      manifest?.maxLineBudgets[normalizeRelative(relPath)] ?? defaultBudgetFor(relPath);
    if (maxLines === null || maxLines === undefined) {
      continue;
    }
    const count = lineCount(content);
    const justified = hasBudgetJustification(content);
    const status = count > maxLines && !justified ? 'warn' : 'pass';
    summary.push({
      path: relPath,
      lineCount: count,
      maxLines,
      status,
      justification: justified,
    });
    if (status === 'warn') {
      addFinding(findings, {
        severity: 'warn',
        code: 'line_budget.exceeded',
        message: `line budget exceeded (${count}/${maxLines}) without explicit justification`,
        path: relPath,
      });
    }
  }
  return summary;
}

function classifyDoc(relPath: string, manifest: DocsManifest | null): string {
  const normalized = normalizeRelative(relPath);
  if (manifest?.maintainedDocs.map(normalizeRelative).includes(normalized))
    return 'CURRENT_AUTHORITY';
  if (manifest?.historicalDocs.map(normalizeRelative).includes(normalized)) return 'HISTORICAL';
  if (manifest?.generatedEvidence.some((pattern) => matchesGlob(normalized, pattern)))
    return 'GENERATED_EVIDENCE';
  if (manifest?.doNotUseAsAuthorityGlobs.some((pattern) => matchesGlob(normalized, pattern)))
    return 'DO_NOT_USE_AS_AUTHORITY';
  if (normalized.includes('/archive/') || normalized.startsWith('archive/')) return 'ARCHIVE';
  if (/deprecated/i.test(normalized)) return 'DEPRECATED';
  if (
    KNOWN_DOCS.includes(normalized as (typeof KNOWN_DOCS)[number]) ||
    normalized.endsWith('/AGENTS.md')
  )
    return 'CURRENT_AUTHORITY';
  return 'UNCLASSIFIED';
}

function checkManifestDocExistence(
  root: string,
  manifest: DocsManifest | null,
  findings: DocsAuditFinding[],
): void {
  if (!manifest) {
    return;
  }
  for (const relPath of manifest.maintainedDocs) {
    const fullPath = pathFromRepo(root, relPath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      addFinding(findings, {
        severity: 'error',
        code: 'maintained_doc.missing',
        message: `maintained doc is missing: ${relPath}`,
        path: relPath,
      });
    }
  }
  for (const relPath of manifest.historicalDocs) {
    const fullPath = pathFromRepo(root, relPath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      addFinding(findings, {
        severity: 'warn',
        code: 'historical_doc.missing',
        message: `historical doc listed in manifest is missing: ${relPath}`,
        path: relPath,
      });
    }
  }
}

function checkHistoricalHeaders(
  root: string,
  manifest: DocsManifest | null,
  findings: DocsAuditFinding[],
): void {
  if (!manifest) {
    return;
  }
  for (const relPath of manifest.historicalDocs) {
    const content = readText(pathFromRepo(root, relPath));
    if (content === null) {
      continue;
    }
    const head = content.split(/\r?\n/).slice(0, 8).join('\n');
    if (!/\b(HISTORICAL|ARCHIVE|DEPRECATED|DO_NOT_USE_AS_AUTHORITY)\b/.test(head)) {
      addFinding(findings, {
        severity: 'warn',
        code: 'historical_doc.missing_header',
        message: 'historical doc needs a visible non-authority header',
        path: relPath,
      });
    }
  }
}

function checkGeneratedAuthority(
  manifest: DocsManifest | null,
  findings: DocsAuditFinding[],
): void {
  if (!manifest) {
    return;
  }
  for (const relPath of manifest.maintainedDocs) {
    if (
      manifest.generatedEvidence.some((pattern) => matchesGlob(relPath, pattern)) ||
      manifest.doNotUseAsAuthorityGlobs.some((pattern) => matchesGlob(relPath, pattern))
    ) {
      addFinding(findings, {
        severity: 'error',
        code: 'generated.current_authority',
        message: 'generated or do-not-use path cannot be maintained current authority',
        path: relPath,
      });
    }
  }
}

function matchesGlob(relPath: string, pattern: string): boolean {
  const normalizedPath = normalizeRelative(relPath);
  const normalizedPattern = normalizeRelative(pattern);
  const placeholder = '\u0000';
  const escaped = normalizedPattern
    .replace(/\*\*/g, placeholder)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replaceAll(placeholder, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(normalizedPath);
}

function extractMarkdownLinks(content: string): Array<{ target: string; line: number }> {
  const links: Array<{ target: string; line: number }> = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const regex = /!?\[[^\]]*\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const raw = match[1]?.trim();
      if (raw) {
        links.push({ target: raw, line: index + 1 });
      }
    }
  }
  return links;
}

function shouldCheckLinks(relPath: string, manifest: DocsManifest | null): boolean {
  const classification = classifyDoc(relPath, manifest);
  return classification !== 'GENERATED_EVIDENCE' && classification !== 'DO_NOT_USE_AS_AUTHORITY';
}

function checkLinks(
  root: string,
  docs: string[],
  manifest: DocsManifest | null,
  findings: DocsAuditFinding[],
): void {
  for (const relPath of docs) {
    if (!shouldCheckLinks(relPath, manifest)) {
      continue;
    }
    const fullPath = pathFromRepo(root, relPath);
    const content = readText(fullPath);
    if (content === null) {
      continue;
    }
    for (const link of extractMarkdownLinks(content)) {
      const cleaned = link.target.replace(/^<|>$/g, '').split('#')[0] ?? '';
      if (!cleaned || /^[a-z]+:/i.test(cleaned) || cleaned.startsWith('#')) {
        continue;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(cleaned);
      } catch {
        decoded = cleaned;
      }
      const normalizedAbsolute = /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
      const targetPath =
        /^[A-Za-z]:[\\/]/.test(normalizedAbsolute) || normalizedAbsolute.startsWith('/')
          ? resolve(normalizedAbsolute)
          : resolve(dirname(fullPath), normalizedAbsolute);
      if (!isInside(root, targetPath)) {
        addFinding(findings, {
          severity: 'error',
          code: 'link.path_escape',
          message: `relative link escapes repo root: ${cleaned}`,
          path: relPath,
          line: link.line,
        });
        continue;
      }
      if (!existsSync(targetPath)) {
        addFinding(findings, {
          severity: 'warn',
          code: 'link.missing_target',
          message: `relative link target does not exist: ${cleaned}`,
          path: relPath,
          line: link.line,
        });
      }
    }
  }
}

function commandText(command: string | TrustedCommandObject): string {
  return typeof command === 'string' ? command : command.command;
}

function commandSource(command: string | TrustedCommandObject): string {
  return typeof command === 'string' ? 'doc' : (command.source ?? 'doc');
}

function checkTrustedCommands(
  root: string,
  manifest: DocsManifest | null,
  findings: DocsAuditFinding[],
): void {
  if (!manifest) {
    return;
  }
  const packageJson = readPackageJson(root);
  for (const command of manifest.trustedCommands) {
    const text = commandText(command);
    const source = commandSource(command);
    if (source === 'external') {
      continue;
    }
    if (!trustedCommandExists(root, text, packageJson)) {
      addFinding(findings, {
        severity: 'warn',
        code: 'trusted_command.not_found',
        message: `trusted command is not found in known manifests: ${text}`,
      });
    }
  }
}

function readPackageJson(root: string): Record<string, unknown> | null {
  const content = readText(join(root, 'package.json'));
  if (content === null) {
    return null;
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function trustedCommandExists(
  root: string,
  command: string,
  packageJson: Record<string, unknown> | null,
): boolean {
  const normalized = command.trim();
  const scripts =
    packageJson && typeof packageJson['scripts'] === 'object' && packageJson['scripts'] !== null
      ? (packageJson['scripts'] as Record<string, unknown>)
      : {};
  if (normalized === 'npm test') {
    return typeof scripts['test'] === 'string';
  }
  const npmRun = /^npm\s+run\s+([A-Za-z0-9:_-]+)/.exec(normalized);
  if (npmRun?.[1]) {
    return typeof scripts[npmRun[1]] === 'string';
  }
  if (/\bgradlew(\.bat)?\b/i.test(normalized)) {
    return existsSync(join(root, 'gradlew')) || existsSync(join(root, 'gradlew.bat'));
  }
  if (/^pytest\b/.test(normalized)) {
    return (
      existsSync(join(root, 'pyproject.toml')) ||
      existsSync(join(root, 'pytest.ini')) ||
      existsSync(join(root, 'tests'))
    );
  }
  return false;
}

function checkDocsMap(
  docs: string[],
  manifest: DocsManifest | null,
  findings: DocsAuditFinding[],
): void {
  const hasComplexDocs =
    docs.filter((path) => path.startsWith('docs/') && path.endsWith('.md')).length >= 5;
  if (!manifest && hasComplexDocs && !docs.includes('docs/README.md')) {
    addFinding(findings, {
      severity: 'warn',
      code: 'docs_map.missing',
      message: 'complex docs folder should include docs/README.md or .babel/docs-manifest.json',
      path: 'docs/README.md',
    });
  }
  if (manifest) {
    const hasCurrent = manifest.maintainedDocs.length > 0;
    const hasHistorical =
      manifest.historicalDocs.length > 0 || manifest.doNotUseAsAuthorityGlobs.length > 0;
    const hasGenerated = manifest.generatedEvidence.length > 0;
    if (!hasCurrent || !hasHistorical || !hasGenerated) {
      addFinding(findings, {
        severity: 'info',
        code: 'docs_map.incomplete_classification',
        message:
          'manifest should distinguish current, historical/do-not-use, and generated docs when those classes exist',
      });
    }
  }
}

function checkSecrets(root: string, docs: string[], findings: DocsAuditFinding[]): void {
  for (const relPath of docs) {
    const content = readText(pathFromRepo(root, relPath));
    if (content === null) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    let inFence = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
      }
      if (/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/.test(line)) {
        addFinding(findings, {
          severity: 'error',
          code: 'secret.private_key',
          message: 'private key material appears in documentation',
          path: relPath,
          line: index + 1,
        });
      }
      if (/\bAKIA[0-9A-Z]{16}\b/.test(line) || /\bghp_[A-Za-z0-9_]{30,}\b/.test(line)) {
        addFinding(findings, {
          severity: 'error',
          code: 'secret.token_value',
          message: 'token-like credential value appears in documentation',
          path: relPath,
          line: index + 1,
        });
      }
      if (inFence) {
        continue;
      }
      const assignment =
        /\b(password|passwd|secret|token|api[_-]?key|private[_-]?key|keystore[_-]?password)\b\s*[:=]\s*["']?([^"'\s`]{10,})/i.exec(
          line,
        );
      if (assignment?.[2] && !isPlaceholderSecret(assignment[2])) {
        addFinding(findings, {
          severity: 'error',
          code: 'secret.assignment_value',
          message: 'credential-like assignment value appears in documentation',
          path: relPath,
          line: index + 1,
        });
      }
    }
  }
}

function isPlaceholderSecret(value: string): boolean {
  return /^(example|placeholder|changeme|redacted|xxxx+|your[-_].*|<.+>)$/i.test(value);
}

function buildCheckedDocs(
  root: string,
  docs: string[],
  manifest: DocsManifest | null,
): CheckedDoc[] {
  return docs.map((relPath) => {
    const content = readText(pathFromRepo(root, relPath)) ?? '';
    return {
      path: relPath,
      classification: classifyDoc(relPath, manifest),
      source:
        manifest &&
        (manifest.maintainedDocs.map(normalizeRelative).includes(relPath) ||
          manifest.historicalDocs.map(normalizeRelative).includes(relPath) ||
          manifest.generatedEvidence.some((pattern) => matchesGlob(relPath, pattern)))
          ? 'manifest'
          : 'discovered',
      lineCount: lineCount(content),
    };
  });
}

export function runDocsAudit(options: { root: string }): DocsAuditReport {
  const repoRoot = resolve(options.root);
  const findings: DocsAuditFinding[] = [];
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    addFinding(findings, {
      severity: 'error',
      code: 'repo_root.missing',
      message: `repo root is missing or is not a directory: ${repoRoot}`,
      path: repoRoot,
    });
    return buildReport(
      repoRoot,
      'missing',
      join(repoRoot, '.babel', 'docs-manifest.json'),
      findings,
      [],
      [],
    );
  }

  const manifestPath = join(repoRoot, '.babel', 'docs-manifest.json');
  const manifest = existsSync(manifestPath) ? parseJsonManifest(manifestPath, findings) : null;
  const manifestState: ManifestState = existsSync(manifestPath)
    ? findings.some((finding) => finding.path === manifestPath && finding.severity === 'error')
      ? 'invalid'
      : 'present'
    : 'missing';

  if (manifest) {
    validateManifestPaths(repoRoot, manifest, findings);
  }

  const docs = new Set(discoverDocs(repoRoot));
  if (manifest) {
    for (const relPath of [...manifest.maintainedDocs, ...manifest.historicalDocs]) {
      docs.add(normalizeRelative(relPath));
    }
  }
  const existingDocs = Array.from(docs)
    .filter(
      (relPath) =>
        existsSync(pathFromRepo(repoRoot, relPath)) &&
        statSync(pathFromRepo(repoRoot, relPath)).isFile(),
    )
    .sort();

  checkManifestDocExistence(repoRoot, manifest, findings);
  checkHistoricalHeaders(repoRoot, manifest, findings);
  checkGeneratedAuthority(manifest, findings);
  checkTrustedCommands(repoRoot, manifest, findings);
  checkLinks(repoRoot, existingDocs, manifest, findings);
  checkDocsMap(existingDocs, manifest, findings);
  checkSecrets(repoRoot, existingDocs, findings);
  const lineBudgetSummary = checkLineBudgets(repoRoot, existingDocs, manifest, findings);

  return buildReport(
    repoRoot,
    manifestState,
    manifestPath,
    findings,
    buildCheckedDocs(repoRoot, existingDocs, manifest),
    lineBudgetSummary,
  );
}

function buildReport(
  repoRoot: string,
  manifestState: ManifestState,
  manifestPath: string,
  findings: DocsAuditFinding[],
  checkedDocs: CheckedDoc[],
  lineBudgetSummary: LineBudgetEntry[],
): DocsAuditReport {
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warn').length;
  const info = findings.filter((finding) => finding.severity === 'info').length;
  return {
    status: errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
    repoRoot,
    manifestStatus: {
      state: manifestState,
      path: manifestPath,
    },
    summary: {
      errors,
      warnings,
      info,
      checkedDocs: checkedDocs.length,
    },
    findings,
    checkedDocs,
    lineBudgetSummary,
  };
}

export function formatDocsAuditHuman(report: DocsAuditReport): string {
  const lines = [
    'Docs fitness audit:',
    `- Status: ${report.status}`,
    `- Repo: ${report.repoRoot}`,
    `- Manifest: ${report.manifestStatus.state}`,
    `- Errors: ${report.summary.errors}`,
    `- Warnings: ${report.summary.warnings}`,
    `- Info: ${report.summary.info}`,
    `- Checked docs: ${report.summary.checkedDocs}`,
  ];
  if (report.findings.length > 0) {
    lines.push('', 'Findings:');
    for (const finding of report.findings) {
      const location = finding.path
        ? ` ${finding.path}${finding.line ? `:${finding.line}` : ''}`
        : '';
      lines.push(
        `- ${finding.severity.toUpperCase()} ${finding.code}:${location} ${finding.message}`,
      );
    }
  }
  lines.push('', 'Cold-start readiness: manual eval still required');
  return lines.join('\n');
}

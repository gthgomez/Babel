import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export type SkillValidationVerdict = 'GREEN' | 'YELLOW' | 'RED';
export type SkillStatus = 'experimental' | 'reviewed' | 'trusted' | 'deprecated';

export interface SkillIssue {
  severity: 'RED' | 'YELLOW';
  code: string;
  message: string;
  path: string;
}

export interface SkillEvidenceReport {
  files_created_changed: string[];
  validation_verdict: SkillValidationVerdict;
  tests_run: string[];
  next_recommended_action: string;
}

export interface SkillValidationResult {
  status: 'ok' | 'fail';
  skill_path: string;
  manifest: Record<string, string | string[] | undefined> | null;
  issues: SkillIssue[];
  verdict: SkillValidationVerdict;
  evidence_report: SkillEvidenceReport;
}

export interface SkillListEntry {
  id: string;
  name: string;
  path: string;
  status: string;
  verdict: SkillValidationVerdict;
}

export interface SkillListReport {
  status: 'ok';
  skills_root: string;
  skills: SkillListEntry[];
  evidence_report: SkillEvidenceReport;
}

export interface SkillCreateReport {
  status: 'ok' | 'fail';
  skill_path: string;
  validation: SkillValidationResult;
  evidence_report: SkillEvidenceReport;
}

export interface SkillAuditReport {
  status: 'ok' | 'fail';
  skill_path: string;
  export_eligible: boolean;
  validation: SkillValidationResult;
  evidence_report: SkillEvidenceReport;
}

export interface SkillExportReport {
  status: 'ok' | 'fail';
  skill_path: string | null;
  destination_path: string;
  validation: SkillValidationResult | null;
  evidence_report: SkillEvidenceReport;
}

export interface SkillDoctorReport {
  status: 'pass' | 'warn' | 'fail';
  skills_root: string;
  skills_checked: number;
  results: SkillValidationResult[];
  evidence_report: SkillEvidenceReport;
}

const REQUIRED_SKILL_FILES = [
  'SKILL.md',
  'skill.yaml',
  'contracts/input.schema.json',
  'contracts/output.schema.json',
  'tests',
] as const;

const REQUIRED_MANIFEST_FIELDS = [
  'id',
  'name',
  'version',
  'status',
  'description',
  'entrypoint',
  'allowed_tools',
  'denied_tools',
  'inputs',
  'outputs',
  'tests',
  'owner',
  'created_at',
  'updated_at',
] as const;

const VALID_SKILL_STATUSES: SkillStatus[] = ['experimental', 'reviewed', 'trusted', 'deprecated'];

function skillRoot(babelRoot: string): string {
  return join(resolve(babelRoot), 'skills');
}

function codexSkillsRoot(): string {
  return process.platform === 'win32'
    ? join(process.env['USERPROFILE'] ?? homedir(), '.codex', 'skills')
    : join(homedir(), '.codex', 'skills');
}

function normalizeSkillId(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new Error('Skill name must contain at least one letter or number.');
  }
  return normalized;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function parseInlineArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  return inner.split(',').map(item => stripQuotes(item)).filter(item => item.length > 0);
}

function parseSimpleYaml(content: string): Record<string, string | string[] | undefined> {
  const lines = content.split(/\r?\n/);
  const manifest: Record<string, string | string[] | undefined> = {};

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (/^\s*(#|$)/.test(line)) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1]!;
    const rawValue = match[2] ?? '';
    const inlineArray = parseInlineArray(rawValue);
    if (inlineArray !== null) {
      manifest[key] = inlineArray;
      continue;
    }

    if (rawValue.trim().length > 0) {
      manifest[key] = stripQuotes(rawValue);
      continue;
    }

    const values: string[] = [];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? '';
      const itemMatch = /^\s+-\s+(.+)$/.exec(nextLine);
      if (!itemMatch) {
        break;
      }
      values.push(stripQuotes(itemMatch[1]!));
      index++;
    }
    manifest[key] = values;
  }

  return manifest;
}

function directoryHasEntries(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length > 0;
}

function readManifest(manifestPath: string, issues: SkillIssue[]): Record<string, string | string[] | undefined> | null {
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return parseSimpleYaml(readFileSync(manifestPath, 'utf-8'));
  } catch (error: unknown) {
    issues.push({
      severity: 'RED',
      code: 'manifest.parse_failed',
      message: `skill.yaml could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      path: manifestPath,
    });
    return null;
  }
}

function validateJsonFile(path: string, issues: SkillIssue[]): void {
  if (!existsSync(path)) {
    return;
  }
  try {
    JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error: unknown) {
    issues.push({
      severity: 'RED',
      code: 'contract.invalid_json',
      message: `${basename(path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      path,
    });
  }
}

function verdictFromIssues(issues: SkillIssue[]): SkillValidationVerdict {
  if (issues.some(issue => issue.severity === 'RED')) {
    return 'RED';
  }
  if (issues.some(issue => issue.severity === 'YELLOW')) {
    return 'YELLOW';
  }
  return 'GREEN';
}

function evidenceReport(
  files: string[],
  verdict: SkillValidationVerdict,
  testsRun: string[],
  nextRecommendedAction: string,
): SkillEvidenceReport {
  return {
    files_created_changed: files,
    validation_verdict: verdict,
    tests_run: testsRun,
    next_recommended_action: nextRecommendedAction,
  };
}

function nextActionForVerdict(verdict: SkillValidationVerdict): string {
  if (verdict === 'RED') {
    return 'Fix RED validation issues before review or export.';
  }
  if (verdict === 'YELLOW') {
    return 'Add README/examples to reach GREEN before requesting review.';
  }
  return 'Move the skill to reviewed or trusted when human review is complete.';
}

function scalarValue(manifest: Record<string, string | string[] | undefined>, key: string): string {
  const value = manifest[key];
  return typeof value === 'string' ? value : '';
}

function validateManifestFields(
  skillPath: string,
  manifest: Record<string, string | string[] | undefined> | null,
  issues: SkillIssue[],
): void {
  const manifestPath = join(skillPath, 'skill.yaml');
  if (!manifest) {
    return;
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in manifest)) {
      issues.push({
        severity: 'RED',
        code: 'manifest.missing_field',
        message: `skill.yaml missing required field: ${field}`,
        path: manifestPath,
      });
    }
  }

  const status = scalarValue(manifest, 'status');
  if (!VALID_SKILL_STATUSES.includes(status as SkillStatus)) {
    issues.push({
      severity: 'RED',
      code: 'manifest.invalid_status',
      message: `status must be one of: ${VALID_SKILL_STATUSES.join(', ')}`,
      path: manifestPath,
    });
  }
}

export function validateSkillPath(pathArg: string): SkillValidationResult {
  const skillPath = resolve(pathArg);
  const issues: SkillIssue[] = [];

  if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) {
    issues.push({
      severity: 'RED',
      code: 'skill.path_missing',
      message: `Skill path is missing or is not a directory: ${skillPath}`,
      path: skillPath,
    });
    const verdict = verdictFromIssues(issues);
    return {
      status: 'fail',
      skill_path: skillPath,
      manifest: null,
      issues,
      verdict,
      evidence_report: evidenceReport([], verdict, ['not run (static validation only)'], nextActionForVerdict(verdict)),
    };
  }

  for (const required of REQUIRED_SKILL_FILES) {
    const requiredPath = join(skillPath, required);
    if (!existsSync(requiredPath)) {
      issues.push({
        severity: 'RED',
        code: required.startsWith('contracts/') ? 'skill.missing_contracts' : `skill.missing_${required.replace(/[/.]/g, '_')}`,
        message: `Missing required skill file or directory: ${required}`,
        path: requiredPath,
      });
    }
  }

  const testsPath = join(skillPath, 'tests');
  if (existsSync(testsPath) && !directoryHasEntries(testsPath)) {
    issues.push({
      severity: 'RED',
      code: 'skill.missing_tests',
      message: 'tests/ exists but contains no test artifacts.',
      path: testsPath,
    });
  }

  const examplesPath = join(skillPath, 'examples');
  if (!directoryHasEntries(examplesPath)) {
    issues.push({
      severity: 'YELLOW',
      code: 'skill.no_examples',
      message: 'examples/ is missing or empty.',
      path: examplesPath,
    });
  }

  const readmePath = join(skillPath, 'README.md');
  if (!existsSync(readmePath)) {
    issues.push({
      severity: 'YELLOW',
      code: 'skill.no_readme',
      message: 'README.md is missing.',
      path: readmePath,
    });
  }

  validateJsonFile(join(skillPath, 'contracts', 'input.schema.json'), issues);
  validateJsonFile(join(skillPath, 'contracts', 'output.schema.json'), issues);

  const manifest = readManifest(join(skillPath, 'skill.yaml'), issues);
  validateManifestFields(skillPath, manifest, issues);

  const verdict = verdictFromIssues(issues);
  return {
    status: verdict === 'RED' ? 'fail' : 'ok',
    skill_path: skillPath,
    manifest,
    issues,
    verdict,
    evidence_report: evidenceReport([], verdict, ['not run (static validation only)'], nextActionForVerdict(verdict)),
  };
}

export function createSkill(name: string, babelRoot: string): SkillCreateReport {
  const id = normalizeSkillId(name);
  const root = skillRoot(babelRoot);
  const target = join(root, id);

  if (existsSync(target)) {
    const validation = validateSkillPath(target);
    return {
      status: 'fail',
      skill_path: target,
      validation,
      evidence_report: evidenceReport([], validation.verdict, ['not run (skill already exists)'], 'Choose a new skill name or validate the existing skill.'),
    };
  }

  const now = new Date().toISOString();
  const files: Array<{ path: string; content: string }> = [
    {
      path: join(target, 'SKILL.md'),
      content: `# ${name}\n\nDescribe when this Babel skill should be used and the governed workflow it provides.\n`,
    },
    {
      path: join(target, 'skill.yaml'),
      content: [
        `id: ${id}`,
        `name: ${name}`,
        'version: 0.1.0',
        'status: experimental',
        'description: TODO: describe this skill.',
        'entrypoint: SKILL.md',
        'allowed_tools: []',
        'denied_tools: []',
        'inputs: contracts/input.schema.json',
        'outputs: contracts/output.schema.json',
        'tests: tests/',
        'owner: unassigned',
        `created_at: ${now}`,
        `updated_at: ${now}`,
        '',
      ].join('\n'),
    },
    {
      path: join(target, 'contracts', 'input.schema.json'),
      content: `${JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: true,
      }, null, 2)}\n`,
    },
    {
      path: join(target, 'contracts', 'output.schema.json'),
      content: `${JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: true,
      }, null, 2)}\n`,
    },
    {
      path: join(target, 'README.md'),
      content: `# ${name}\n\nStatus: experimental\n\nAdd usage notes, expected inputs, expected outputs, and review evidence here.\n`,
    },
    {
      path: join(target, 'examples', 'example.md'),
      content: `# Example\n\nAdd a minimal input/output example for ${name}.\n`,
    },
    {
      path: join(target, 'tests', 'validation.test.md'),
      content: `# Test Plan\n\n- Validate input and output contracts.\n- Add executable tests before moving this skill to reviewed or trusted.\n`,
    },
  ];

  const changed: string[] = [];
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, 'utf-8');
    changed.push(file.path);
  }

  const validation = validateSkillPath(target);
  return {
    status: validation.status,
    skill_path: target,
    validation,
    evidence_report: evidenceReport(changed, validation.verdict, ['not run (scaffold only)'], nextActionForVerdict(validation.verdict)),
  };
}

export function auditSkillPath(pathArg: string): SkillAuditReport {
  const validation = validateSkillPath(pathArg);
  const status = validation.manifest ? scalarValue(validation.manifest, 'status') : '';
  const exportEligible = validation.verdict !== 'RED' && (status === 'reviewed' || status === 'trusted');
  const next = exportEligible
    ? 'Skill is eligible for default Codex export.'
    : validation.verdict === 'RED'
      ? nextActionForVerdict(validation.verdict)
      : 'Promote status to reviewed or trusted before default Codex export.';

  return {
    status: validation.status,
    skill_path: validation.skill_path,
    export_eligible: exportEligible,
    validation,
    evidence_report: evidenceReport([], validation.verdict, ['not run (static audit only)'], next),
  };
}

export function listSkills(babelRoot: string): SkillListReport {
  const root = skillRoot(babelRoot);
  const skills = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => validateSkillPath(join(root, entry.name)))
      .map((result): SkillListEntry => ({
        id: result.manifest ? scalarValue(result.manifest, 'id') || basename(result.skill_path) : basename(result.skill_path),
        name: result.manifest ? scalarValue(result.manifest, 'name') || basename(result.skill_path) : basename(result.skill_path),
        path: result.skill_path,
        status: result.manifest ? scalarValue(result.manifest, 'status') || 'unknown' : 'unknown',
        verdict: result.verdict,
      }))
    : [];

  return {
    status: 'ok',
    skills_root: root,
    skills,
    evidence_report: evidenceReport([], skills.some(skill => skill.verdict === 'RED') ? 'RED' : skills.some(skill => skill.verdict === 'YELLOW') ? 'YELLOW' : 'GREEN', ['not run (list performs static validation only)'], skills.length === 0 ? 'Create a skill with babel skill new <name>.' : 'Validate or audit a skill before review/export.'),
  };
}

function findSkill(name: string, babelRoot: string): string | null {
  const root = skillRoot(babelRoot);
  if (!existsSync(root)) {
    return null;
  }

  const normalized = normalizeSkillId(name);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(root, entry.name);
    const validation = validateSkillPath(path);
    const manifestId = validation.manifest ? scalarValue(validation.manifest, 'id') : '';
    const rawManifestName = validation.manifest ? scalarValue(validation.manifest, 'name') : '';
    const manifestName = rawManifestName.trim().length > 0 ? normalizeSkillId(rawManifestName) : '';
    if (entry.name === normalized || manifestId === normalized || manifestName === normalized) {
      return path;
    }
  }
  return null;
}

function copyDirectory(source: string, destination: string, changed: string[]): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath, changed);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    mkdirSync(resolve(destinationPath, '..'), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
    changed.push(destinationPath);
  }
}

export function exportSkillToCodex(
  name: string,
  babelRoot: string,
  options: { allowExperimental?: boolean; destinationRoot?: string } = {},
): SkillExportReport {
  const destinationRoot = resolve(options.destinationRoot ?? codexSkillsRoot());
  const source = findSkill(name, babelRoot);
  if (!source) {
    const verdict: SkillValidationVerdict = 'RED';
    return {
      status: 'fail',
      skill_path: null,
      destination_path: destinationRoot,
      validation: null,
      evidence_report: evidenceReport([], verdict, ['not run (skill lookup failed)'], 'Create or list skills before exporting.'),
    };
  }

  const validation = validateSkillPath(source);
  const status = validation.manifest ? scalarValue(validation.manifest, 'status') : '';
  if (validation.verdict === 'RED') {
    return {
      status: 'fail',
      skill_path: source,
      destination_path: destinationRoot,
      validation,
      evidence_report: evidenceReport([], validation.verdict, ['not run (export blocked by validation)'], nextActionForVerdict(validation.verdict)),
    };
  }

  if (status === 'experimental' && options.allowExperimental !== true) {
    return {
      status: 'fail',
      skill_path: source,
      destination_path: destinationRoot,
      validation,
      evidence_report: evidenceReport([], validation.verdict, ['not run (export blocked by experimental status)'], 'Re-run with --allow-experimental or promote the skill to reviewed/trusted.'),
    };
  }

  if (status !== 'reviewed' && status !== 'trusted' && status !== 'experimental') {
    return {
      status: 'fail',
      skill_path: source,
      destination_path: destinationRoot,
      validation,
      evidence_report: evidenceReport([], validation.verdict, ['not run (export blocked by status)'], 'Only reviewed or trusted skills export by default.'),
    };
  }

  const target = join(destinationRoot, basename(source));
  const changed: string[] = [];
  copyDirectory(source, target, changed);

  return {
    status: 'ok',
    skill_path: source,
    destination_path: target,
    validation,
    evidence_report: evidenceReport(changed, validation.verdict, ['not run (copy/export only)'], 'Run babel skill audit on the exported skill if you need a second evidence pass.'),
  };
}

export function runSkillDoctor(babelRoot: string): SkillDoctorReport {
  const root = skillRoot(babelRoot);
  const results = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => validateSkillPath(join(root, entry.name)))
    : [];
  const verdict: SkillValidationVerdict = results.some(result => result.verdict === 'RED')
    ? 'RED'
    : results.some(result => result.verdict === 'YELLOW') || results.length === 0
      ? 'YELLOW'
      : 'GREEN';

  return {
    status: verdict === 'RED' ? 'fail' : verdict === 'YELLOW' ? 'warn' : 'pass',
    skills_root: root,
    skills_checked: results.length,
    results,
    evidence_report: evidenceReport([], verdict, ['not run (doctor performs static validation only)'], results.length === 0 ? 'Create a skill with babel skill new <name>.' : nextActionForVerdict(verdict)),
  };
}

export function formatEvidenceReport(report: SkillEvidenceReport): string {
  return [
    'Evidence report:',
    `- files created/changed: ${report.files_created_changed.length > 0 ? report.files_created_changed.join(', ') : '(none)'}`,
    `- validation verdict: ${report.validation_verdict}`,
    `- tests run: ${report.tests_run.join(', ')}`,
    `- next recommended action: ${report.next_recommended_action}`,
  ].join('\n');
}

export function formatValidationHuman(result: SkillValidationResult): string {
  const lines = [
    `Skill validation: ${result.verdict}`,
    `Path: ${result.skill_path}`,
  ];
  if (result.issues.length === 0) {
    lines.push('Issues: none');
  } else {
    lines.push('Issues:');
    for (const issue of result.issues) {
      lines.push(`- ${issue.severity} ${issue.code}: ${issue.message}`);
    }
  }
  lines.push(formatEvidenceReport(result.evidence_report));
  return lines.join('\n');
}

export function formatSkillListHuman(report: SkillListReport): string {
  const lines = [
    `Babel skills: ${report.skills.length}`,
    `Root: ${report.skills_root}`,
  ];
  for (const skill of report.skills) {
    lines.push(`- ${skill.id} (${skill.status}) ${skill.verdict} :: ${skill.path}`);
  }
  lines.push(formatEvidenceReport(report.evidence_report));
  return lines.join('\n');
}

export function formatSkillCreateHuman(report: SkillCreateReport): string {
  return [
    report.status === 'ok' ? `Created skill: ${report.skill_path}` : `Skill not created: ${report.skill_path}`,
    formatValidationHuman(report.validation),
    formatEvidenceReport(report.evidence_report),
  ].join('\n');
}

export function formatSkillAuditHuman(report: SkillAuditReport): string {
  return [
    `Skill audit: ${report.validation.verdict}`,
    `Path: ${report.skill_path}`,
    `Export eligible: ${report.export_eligible ? 'yes' : 'no'}`,
    formatValidationHuman(report.validation),
    formatEvidenceReport(report.evidence_report),
  ].join('\n');
}

export function formatSkillExportHuman(report: SkillExportReport): string {
  return [
    `Codex skill export: ${report.status}`,
    `Source: ${report.skill_path ?? '(not found)'}`,
    `Destination: ${report.destination_path}`,
    report.validation ? `Validation: ${report.validation.verdict}` : 'Validation: RED',
    formatEvidenceReport(report.evidence_report),
  ].join('\n');
}

export function formatSkillDoctorHuman(report: SkillDoctorReport): string {
  const lines = [
    'Babel Skill Doctor',
    `Root: ${report.skills_root}`,
    `Skills checked: ${report.skills_checked}`,
    `Overall: ${report.status.toUpperCase()}`,
  ];
  for (const result of report.results) {
    lines.push(`- ${basename(result.skill_path)}: ${result.verdict}`);
  }
  lines.push(formatEvidenceReport(report.evidence_report));
  return lines.join('\n');
}

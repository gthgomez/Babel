import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ToolCallLog } from '../schemas/agentContracts.js';

export type ExactInvariantKind =
  | 'literal_string'
  | 'filename'
  | 'command'
  | 'cli_flag'
  | 'required_value'
  | 'output_snippet';

export interface ExactInvariant {
  id: string;
  kind: ExactInvariantKind;
  value: string;
  source: 'quoted' | 'exact_phrase' | 'path' | 'flag' | 'command' | 'required_value';
  required: true;
  case_sensitive: true;
  reason: string;
}

export interface ExactInvariantRegistry {
  schema_version: 1;
  invariants: ExactInvariant[];
  file_literal_constraints: ExactFileLiteralConstraint[];
}

export interface ExactInvariantFailure {
  invariant: ExactInvariant;
  reason: string;
  evidence: string[];
}

export interface ExactInvariantCheckResult {
  passed: boolean;
  checked: ExactInvariant[];
  failures: ExactInvariantFailure[];
}

interface AddInvariantInput {
  kind: ExactInvariantKind;
  value: string;
  source: ExactInvariant['source'];
  reason: string;
}

interface CandidateFile {
  relativePath: string;
  fullPath: string;
}

export type ExactFileLiteralRelation = 'contains' | 'entire_file_equals';

export interface ExactFileLiteralConstraint {
  kind: 'file_literal_constraint';
  path: string;
  literal: string;
  relation: ExactFileLiteralRelation;
  source: 'bound_phrase' | 'inferred_single_pair';
  required: true;
  case_sensitive: true;
  reason: string;
}

export type FileLiteralBindingResolution =
  | { status: 'matched'; constraint: ExactFileLiteralConstraint }
  | { status: 'ambiguous'; reason: string }
  | { status: 'none' };

export const EXACT_INSTRUCTION_DRIFT_STATUS = 'EXACT_INSTRUCTION_DRIFT' as const;
export const AMBIGUOUS_LITERAL_BINDING_STATUS = 'AMBIGUOUS_LITERAL_BINDING' as const;

const NON_FILE_DOTTED_TOKENS = new Set([
  'next.js',
  'node.js',
  'react.js',
  'vue.js',
  'express.js',
  'electron.js',
  'backbone.js',
  'ember.js',
  'nuxt.js',
  'svelte.js',
]);

const KNOWN_STANDALONE_FILE_EXTENSIONS = new Set([
  'cjs',
  'comp',
  'css',
  'csv',
  'gd',
  'html',
  'java',
  'js',
  'json',
  'kt',
  'md',
  'mjs',
  'ps1',
  'py',
  'sh',
  'ts',
  'tsx',
  'txt',
  'yaml',
  'yml',
]);

const TEXT_FILE_EXTENSION_PATTERN =
  /\.(?:c|cc|cpp|cs|css|csv|gd|go|h|hpp|html|java|js|jsx|json|kt|md|mjs|py|rb|rs|sh|sql|ts|tsx|txt|xml|yaml|yml)$/i;

const SKIPPED_SEARCH_DIRS = new Set([
  '.git',
  '.godot',
  '.gradle',
  '.idea',
  '.next',
  '.turbo',
  '.venv',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'runs',
  'target',
]);

const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_FILE_BYTES = 512_000;

function normalizePathForComparison(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function cleanQuotedLiteral(value: string): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function cleanUnquotedLiteral(value: string): string {
  return String(value ?? '')
    .replace(/\s+(?:in|to|from|when|if|with|using|before|after)\b[\s\S]*$/i, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[),.;:]+$/g, '')
    .trim();
}

function cleanBoundLiteral(value: string): string {
  const cleaned = cleanUnquotedLiteral(value);
  const quoted = /^["'`]([\s\S]*)["'`]$/.exec(cleaned);
  return quoted?.[1] ?? cleaned;
}

function isLikelyFilePath(value: string): boolean {
  const normalized = normalizePathForComparison(value);
  if (
    !normalized ||
    normalized.includes('*') ||
    normalized.includes('<') ||
    normalized.includes('>')
  ) {
    return false;
  }
  if (NON_FILE_DOTTED_TOKENS.has(normalized.toLowerCase())) {
    return false;
  }
  const basename = normalized.split('/').at(-1) ?? normalized;
  const extension = basename.split('.').at(-1)?.toLowerCase() ?? '';
  if (!basename.includes('.')) {
    return false;
  }
  if (!normalized.includes('/') && (basename.match(/\./g)?.length ?? 0) > 1) {
    return false;
  }
  return KNOWN_STANDALONE_FILE_EXTENSIONS.has(extension) || normalized.includes('/');
}

function isLikelyCommand(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    return false;
  }
  return (
    /^(?:\.\/)?(?:npm|npx|pnpm|yarn|node|tsx|tsc|python|python3|pytest|jest|vitest|gradle|gradlew|git|docker|go|cargo|make|java|kotlinc|babel)\b/i.test(
      trimmed,
    ) || /\s--[a-z0-9][a-z0-9-]*/i.test(trimmed)
  );
}

function addInvariant(invariants: AddInvariantInput[], input: AddInvariantInput): void {
  const value =
    input.kind === 'filename' ? normalizePathForComparison(input.value) : input.value.trim();
  if (!value) {
    return;
  }
  const key = `${input.kind}\0${value}`;
  if (invariants.some((existing) => `${existing.kind}\0${existing.value}` === key)) {
    return;
  }
  invariants.push({ ...input, value });
}

function addFileLiteralConstraint(
  constraints: ExactFileLiteralConstraint[],
  input: Omit<ExactFileLiteralConstraint, 'kind' | 'required' | 'case_sensitive'>,
): void {
  const path = normalizePathForComparison(input.path);
  const literal = input.literal.trim();
  if (!path || !literal) {
    return;
  }
  const key = `${path}\0${literal}\0${input.relation}`;
  if (
    constraints.some(
      (existing) => `${existing.path}\0${existing.literal}\0${existing.relation}` === key,
    )
  ) {
    return;
  }
  constraints.push({
    kind: 'file_literal_constraint',
    path,
    literal,
    relation: input.relation,
    source: input.source,
    required: true,
    case_sensitive: true,
    reason: input.reason,
  });
}

function extractQuotedExactLiterals(task: string, invariants: AddInvariantInput[]): void {
  const patterns: Array<{ pattern: RegExp; kind: ExactInvariantKind; reason: string }> = [
    {
      pattern:
        /\b(?:exact|literal|verbatim)\s+(?:string|text|output|snippet|value|contents?)\b\s*(?:of|as|:)?\s*["'`]([^"'`\r\n]+)["'`]/gi,
      kind: 'literal_string',
      reason: 'quoted literal following exact/literal/verbatim instruction',
    },
    {
      pattern:
        /\b(?:returns?|prints?|outputs?|emits?|says?|contain(?:s|ing)?|writes?)\b[^.\r\n]{0,100}\b(?:exact|literal|verbatim)\b[^"'`\r\n]{0,60}["'`]([^"'`\r\n]+)["'`]/gi,
      kind: 'literal_string',
      reason: 'quoted exact output literal',
    },
    {
      pattern:
        /\b(?:value|status|final\s+status|label|message|output|text|string|constant)\b[^.\r\n]{0,100}\b(?:must|should|is|be|equal|equals?|set\s+to)\b[^"'`\r\n]{0,60}["'`]([^"'`\r\n]+)["'`]/gi,
      kind: 'required_value',
      reason: 'quoted required value',
    },
    {
      pattern:
        /\b(?:returns?|prints?|outputs?|emits?|says?|contain(?:s|ing)?|writes?)\s+["']([^"'\r\n]+)["']/gi,
      kind: 'output_snippet',
      reason: 'quoted requested output snippet',
    },
  ];

  for (const { pattern, kind, reason } of patterns) {
    for (const match of task.matchAll(pattern)) {
      const value = cleanQuotedLiteral(match[1] ?? '');
      addInvariant(invariants, {
        kind,
        value,
        source: kind === 'required_value' ? 'required_value' : 'quoted',
        reason,
      });
    }
  }
}

function extractUnquotedExactLiterals(task: string, invariants: AddInvariantInput[]): void {
  for (const match of task.matchAll(/\b(?:exact|literal|verbatim)\s+strings\b\s+([^.\r\n;]+)/gi)) {
    const rawValue = String(match[1] ?? '').trim();
    for (const part of rawValue.split(/\s+(?:and|or)\s+|,/i)) {
      const value = cleanUnquotedLiteral(part);
      if (value && !isLikelyFilePath(value) && !isLikelyCommand(value)) {
        addInvariant(invariants, {
          kind: 'literal_string',
          value,
          source: 'exact_phrase',
          reason: 'unquoted exact/literal/verbatim plural instruction',
        });
      }
    }
  }

  const patterns: RegExp[] = [
    /\b(?:returns?|prints?|outputs?|emits?|says?|contain(?:s|ing)?|writes?)\s+(?:the\s+)?(?:exact|literal|verbatim)\s+(?:(?:string|text|output|snippet|value|contents?)\b)?\s+([^.\r\n;]+)/gi,
    /\b(?:exact|literal|verbatim)\s+(?:string|text|output|snippet|value|contents?)\b\s+([^.\r\n;]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of task.matchAll(pattern)) {
      const rawValue = String(match[1] ?? '').trim();
      if (/^["'`]/.test(rawValue)) {
        continue;
      }
      const value = cleanUnquotedLiteral(rawValue);
      if (value && !isLikelyFilePath(value) && !isLikelyCommand(value)) {
        addInvariant(invariants, {
          kind: 'literal_string',
          value,
          source: 'exact_phrase',
          reason: 'unquoted exact/literal/verbatim instruction',
        });
      }
    }
  }
}

function extractFileLiteralConstraints(task: string): ExactFileLiteralConstraint[] {
  const constraints: ExactFileLiteralConstraint[] = [];
  const filePattern = String.raw`((?:[A-Za-z]:[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]{1,12})`;
  const literalPattern =
    String.raw`(?:"([^"\r\n]+)"|'([^'\r\n]+)'|` + '`([^`\\r\\n]+)`' + String.raw`|([^.\r\n;]+))`;
  const patterns: Array<{ pattern: RegExp; relation: ExactFileLiteralRelation; reason: string }> = [
    {
      pattern: new RegExp(
        `${filePattern}\\b[^.\\r\\n;]{0,160}\\b(?:entire\\s+(?:file\\s+)?contents?|whole\\s+(?:file\\s+)?contents?|full\\s+contents?)\\s+(?:are|is|equals?|equal|be)\\s+(?:the\\s+)?exact\\s+(?:(?:string|text|literal)\\b)?\\s*${literalPattern}`,
        'gi',
      ),
      relation: 'entire_file_equals',
      reason: 'file path bound to exact entire-file content literal',
    },
    {
      pattern: new RegExp(
        `${filePattern}\\b[^.\\r\\n;]{0,120}\\b(?:contain(?:s|ing)?|with|include(?:s|ing)?)\\b[^.\\r\\n;]{0,80}\\bexact\\s+(?:string|text|literal)\\b\\s*${literalPattern}`,
        'gi',
      ),
      relation: 'contains',
      reason: 'file path bound to contained exact literal',
    },
  ];

  for (const { pattern, relation, reason } of patterns) {
    for (const match of task.matchAll(pattern)) {
      const path = match[1]?.trim() ?? '';
      const literal = cleanBoundLiteral(match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
      if (!isLikelyFilePath(path) || !literal || isLikelyFilePath(literal)) {
        continue;
      }
      addFileLiteralConstraint(constraints, {
        path,
        literal,
        relation,
        source: 'bound_phrase',
        reason,
      });
    }
  }

  return constraints;
}

function extractFilenameInvariants(task: string, invariants: AddInvariantInput[]): void {
  const pathMatches =
    task.match(
      /(?:[A-Za-z]:[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]{1,12}/g,
    ) ?? [];
  for (const match of pathMatches) {
    if (isLikelyFilePath(match)) {
      addInvariant(invariants, {
        kind: 'filename',
        value: match,
        source: 'path',
        reason: 'path-like filename requested by user',
      });
    }
  }

  const namedPatterns = [
    /\b(?:new\s+)?file\s+(?:called|named)\s+["'`]?([A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12})["'`]?/gi,
    /\b(?:binary\s+)?executable\s+(?:called|named)\s+["'`]?([A-Za-z0-9_.-]+)["'`]?/gi,
    /\b(?:command|tool|program)\s+(?:called|named)\s+["'`]?([A-Za-z0-9_.-]+)["'`]?/gi,
  ];
  for (const pattern of namedPatterns) {
    for (const match of task.matchAll(pattern)) {
      const value = match[1]?.trim() ?? '';
      if (value && !value.includes('*') && value !== '.' && value !== '..') {
        addInvariant(invariants, {
          kind: value.includes('.') ? 'filename' : 'command',
          value,
          source: value.includes('.') ? 'path' : 'command',
          reason: value.includes('.') ? 'named output filename' : 'named command/tool',
        });
      }
    }
  }
}

function extractCommandAndFlagInvariants(task: string, invariants: AddInvariantInput[]): void {
  for (const match of task.matchAll(/--[a-z0-9][a-z0-9-]*/gi)) {
    addInvariant(invariants, {
      kind: 'cli_flag',
      value: match[0] ?? '',
      source: 'flag',
      reason: 'CLI flag mentioned literally',
    });
  }

  for (const match of task.matchAll(/`([^`\r\n]+)`/g)) {
    const value = cleanQuotedLiteral(match[1] ?? '');
    if (!value) {
      continue;
    }
    if (/^--[a-z0-9][a-z0-9-]*$/i.test(value)) {
      addInvariant(invariants, {
        kind: 'cli_flag',
        value,
        source: 'flag',
        reason: 'backticked CLI flag',
      });
    } else if (isLikelyCommand(value)) {
      addInvariant(invariants, {
        kind: 'command',
        value,
        source: 'command',
        reason: 'backticked command',
      });
    } else if (isLikelyFilePath(value)) {
      addInvariant(invariants, {
        kind: 'filename',
        value,
        source: 'path',
        reason: 'backticked filename/path',
      });
    } else {
      const matchIndex = match.index ?? 0;
      const prefix = task.slice(Math.max(0, matchIndex - 120), matchIndex);
      if (/\b(?:status|final\s+status|value|constant|literal|exact|mode|label)\b/i.test(prefix)) {
        addInvariant(invariants, {
          kind: 'required_value',
          value,
          source: 'required_value',
          reason: 'backticked required value',
        });
      }
    }
  }
}

// Task metadata lines injected by the orchestrator. These describe pipeline
// configuration, not user-facing requirements, and must be excluded from exact
// invariant extraction to avoid false-positive literal constraints.
const ORCHESTRATOR_METADATA_PATTERN =
  /\b(?:Preferred project|Preferred pipeline mode|Preferred execution profile|Execution profile)\s*:.*$/gim;

export function extractExactInvariants(rawTask: string): ExactInvariantRegistry {
  // Strip orchestrator metadata before extracting invariants — metadata is not
  // part of the user's task and should not generate exact literal constraints.
  const task = String(rawTask ?? '')
    .replace(ORCHESTRATOR_METADATA_PATTERN, '')
    .trim();
  // Also strip trailing metadata that follows the form "Execution profile <name>"
  // which appears without the "Preferred" prefix on a separate line.
  const cleanTask = task.replace(/^\s*Execution profile\s*[^\n]*$/gim, '').trim();
  const invariants: AddInvariantInput[] = [];
  const fileLiteralConstraints = extractFileLiteralConstraints(cleanTask);

  extractFilenameInvariants(cleanTask, invariants);
  extractQuotedExactLiterals(cleanTask, invariants);
  extractUnquotedExactLiterals(cleanTask, invariants);
  extractCommandAndFlagInvariants(cleanTask, invariants);

  return {
    schema_version: 1,
    file_literal_constraints: fileLiteralConstraints,
    invariants: invariants.map((invariant, index) => ({
      id: `exact-${index + 1}`,
      kind: invariant.kind,
      value: invariant.value,
      source: invariant.source,
      required: true,
      case_sensitive: true,
      reason: invariant.reason,
    })),
  };
}

export function formatExactInvariantPromptLines(
  registry: ExactInvariantRegistry,
  audience: 'planning' | 'qa' | 'executor' | 'general' = 'general',
): string[] {
  if (registry.invariants.length === 0 && registry.file_literal_constraints.length === 0) {
    return [];
  }

  const heading =
    audience === 'qa'
      ? '--- EXACT INSTRUCTION INVARIANT REVIEW ---'
      : audience === 'executor'
        ? 'Exact instruction invariant execution contract:'
        : 'Exact instruction invariant registry:';
  const rule =
    audience === 'qa'
      ? 'Reject the plan if any invariant is omitted, paraphrased, renamed, relocated, or treated semantically instead of literally.'
      : audience === 'executor'
        ? 'Do NOT emit EXECUTION_COMPLETE unless every invariant below is present exactly as written; semantic paraphrases fail.'
        : 'Preserve every invariant below exactly as written; semantic paraphrases fail.';

  return [
    heading,
    rule,
    ...registry.file_literal_constraints.map(
      (constraint) =>
        `  - file_literal_constraint: ${constraint.path} ${constraint.relation} "${constraint.literal}" (${constraint.reason})`,
    ),
    ...registry.invariants.map(
      (invariant) => `  - ${invariant.kind}: "${invariant.value}" (${invariant.reason})`,
    ),
  ];
}

export function resolveFileLiteralBinding(
  registry: ExactInvariantRegistry,
  target: string,
): FileLiteralBindingResolution {
  const normalizedTarget = normalizePathForComparison(target).toLowerCase();
  const directMatches = registry.file_literal_constraints.filter(
    (constraint) =>
      constraint.path.toLowerCase() === normalizedTarget ||
      constraint.path.split('/').at(-1)?.toLowerCase() === normalizedTarget.split('/').at(-1),
  );
  if (directMatches.length === 1) {
    return { status: 'matched', constraint: directMatches[0]! };
  }
  if (directMatches.length > 1) {
    return {
      status: 'ambiguous',
      reason: `multiple exact literals are bound to "${target}"`,
    };
  }

  const filenameCount = registry.invariants.filter(
    (invariant) => invariant.kind === 'filename',
  ).length;
  const literalInvariants = registry.invariants.filter(
    (invariant) =>
      invariant.kind === 'literal_string' ||
      invariant.kind === 'output_snippet' ||
      invariant.kind === 'required_value',
  );
  if (filenameCount > 1 && literalInvariants.length > 1) {
    return {
      status: 'ambiguous',
      reason:
        'multiple filenames and multiple exact literals were requested without a one-to-one binding',
    };
  }

  return { status: 'none' };
}

function isWithinProjectRoot(projectRoot: string, candidatePath: string): boolean {
  const rel = relative(resolve(projectRoot), resolve(candidatePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveInvariantFile(
  projectRoot: string,
  invariant: ExactInvariant,
): CandidateFile | null {
  const normalized = normalizePathForComparison(invariant.value);
  const directPath = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(projectRoot, normalized);
  if (!isWithinProjectRoot(projectRoot, directPath)) {
    return null;
  }
  if (existsSync(directPath) && statSync(directPath).isFile()) {
    return {
      relativePath: normalizePathForComparison(relative(projectRoot, directPath)),
      fullPath: directPath,
    };
  }
  if (!normalized.includes('/')) {
    const match = listProjectTextFiles(projectRoot, true).find(
      (file) => file.relativePath.split('/').at(-1) === normalized,
    );
    return match ?? null;
  }
  return null;
}

function listProjectTextFiles(projectRoot: string, includeNonTextNames = false): CandidateFile[] {
  const files: CandidateFile[] = [];

  const visit = (directory: string, relativePrefix = ''): void => {
    if (files.length >= MAX_SEARCH_FILES || !existsSync(directory)) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SEARCH_FILES) {
        return;
      }
      if (entry.isDirectory() && SKIPPED_SEARCH_DIRS.has(entry.name)) {
        continue;
      }
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!includeNonTextNames && !TEXT_FILE_EXTENSION_PATTERN.test(entry.name)) {
        continue;
      }
      try {
        if (statSync(fullPath).size > MAX_SEARCH_FILE_BYTES) {
          continue;
        }
      } catch {
        continue;
      }
      files.push({ relativePath: normalizePathForComparison(relativePath), fullPath });
    }
  };

  visit(resolve(projectRoot));
  return files;
}

function readCandidateFile(file: CandidateFile): string | null {
  try {
    return readFileSync(file.fullPath, 'utf-8');
  } catch {
    return null;
  }
}

function toolLogsContainExactValue(toolCallLog: readonly ToolCallLog[], value: string): boolean {
  return toolCallLog.some(
    (entry) =>
      String(entry.target ?? '').includes(value) ||
      String(entry.stdout ?? '').includes(value) ||
      String(entry.stderr ?? '').includes(value),
  );
}

function commandWasExecuted(toolCallLog: readonly ToolCallLog[], command: string): boolean {
  const expected = command.replace(/\s+/g, ' ').trim();
  return toolCallLog.some((entry) => {
    if (entry.tool !== 'shell_exec' && entry.tool !== 'test_run') {
      return false;
    }
    const actual = String(entry.target ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return actual === expected || actual.includes(expected);
  });
}

function projectFilesContainExactValue(
  projectRoot: string,
  value: string,
  preferredFiles: CandidateFile[],
): string | null {
  const candidates = preferredFiles.length > 0 ? preferredFiles : listProjectTextFiles(projectRoot);

  for (const file of candidates) {
    if (!TEXT_FILE_EXTENSION_PATTERN.test(file.relativePath)) {
      continue;
    }
    const content = readCandidateFile(file);
    if (content?.includes(value)) {
      return file.relativePath;
    }
  }
  return null;
}

export function verifyExactInvariants(input: {
  registry: ExactInvariantRegistry;
  projectRoot: string | null;
  toolCallLog?: readonly ToolCallLog[];
}): ExactInvariantCheckResult {
  const toolCallLog = input.toolCallLog ?? [];
  const filenameInvariants = input.registry.invariants.filter(
    (invariant) => invariant.kind === 'filename',
  );
  const resolvedFilenameFiles = input.projectRoot
    ? filenameInvariants
        .map((invariant) => resolveInvariantFile(input.projectRoot as string, invariant))
        .filter((file): file is CandidateFile => file !== null)
    : [];
  const failures: ExactInvariantFailure[] = [];

  for (const invariant of filenameInvariants) {
    const binding = resolveFileLiteralBinding(input.registry, invariant.value);
    if (binding.status === 'ambiguous') {
      failures.push({
        invariant,
        reason: `[${AMBIGUOUS_LITERAL_BINDING_STATUS}] ${binding.reason}`,
        evidence: [`filename=${invariant.value}`],
      });
    }
  }

  for (const constraint of input.registry.file_literal_constraints) {
    const invariant: ExactInvariant = {
      id: `constraint:${constraint.path}`,
      kind: 'literal_string',
      value: constraint.literal,
      source: 'exact_phrase',
      required: true,
      case_sensitive: true,
      reason: constraint.reason,
    };
    if (!input.projectRoot) {
      failures.push({
        invariant,
        reason: `project root unavailable; cannot verify exact literal binding for "${constraint.path}"`,
        evidence: [],
      });
      continue;
    }
    const resolved = resolveInvariantFile(input.projectRoot, {
      ...invariant,
      kind: 'filename',
      value: constraint.path,
      source: 'path',
    });
    if (!resolved) {
      failures.push({
        invariant,
        reason: `file literal constraint target "${constraint.path}" was not found`,
        evidence: [`project_root=${input.projectRoot}`],
      });
      continue;
    }
    const content = readCandidateFile(resolved);
    if (content === null) {
      failures.push({
        invariant,
        reason: `file literal constraint target "${constraint.path}" could not be read`,
        evidence: [resolved.relativePath],
      });
      continue;
    }
    const passed =
      constraint.relation === 'entire_file_equals'
        ? content === constraint.literal
        : content.includes(constraint.literal);
    if (!passed) {
      failures.push({
        invariant,
        reason:
          constraint.relation === 'entire_file_equals'
            ? `file "${constraint.path}" entire content does not exactly equal "${constraint.literal}"`
            : `file "${constraint.path}" does not contain exact literal "${constraint.literal}"`,
        evidence: [resolved.relativePath],
      });
    }
  }

  for (const invariant of input.registry.invariants) {
    if (invariant.kind === 'filename') {
      if (!input.projectRoot) {
        failures.push({
          invariant,
          reason: 'project root unavailable; cannot verify requested filename',
          evidence: [],
        });
        continue;
      }
      const resolved = resolveInvariantFile(input.projectRoot, invariant);
      if (!resolved) {
        failures.push({
          invariant,
          reason: `requested filename "${invariant.value}" was not found in the project root`,
          evidence: [`project_root=${input.projectRoot}`],
        });
      }
      continue;
    }

    if (invariant.kind === 'command') {
      if (
        commandWasExecuted(toolCallLog, invariant.value) ||
        toolLogsContainExactValue(toolCallLog, invariant.value)
      ) {
        continue;
      }
      if (
        input.projectRoot &&
        projectFilesContainExactValue(input.projectRoot, invariant.value, [])
      ) {
        continue;
      }
      failures.push({
        invariant,
        reason: `requested command "${invariant.value}" was not executed or preserved literally`,
        evidence: toolCallLog.map((entry) => `${entry.tool}:${entry.target}`).slice(0, 8),
      });
      continue;
    }

    if (invariant.kind === 'cli_flag') {
      if (toolLogsContainExactValue(toolCallLog, invariant.value)) {
        continue;
      }
      if (
        input.projectRoot &&
        projectFilesContainExactValue(input.projectRoot, invariant.value, [])
      ) {
        continue;
      }
      failures.push({
        invariant,
        reason: `requested CLI flag "${invariant.value}" was not preserved literally`,
        evidence: [],
      });
      continue;
    }

    if (toolLogsContainExactValue(toolCallLog, invariant.value)) {
      continue;
    }

    if (input.projectRoot) {
      const preferredFiles = resolvedFilenameFiles.filter((file) =>
        TEXT_FILE_EXTENSION_PATTERN.test(file.relativePath),
      );
      const match = projectFilesContainExactValue(
        input.projectRoot,
        invariant.value,
        preferredFiles,
      );
      if (match) {
        continue;
      }
    }

    failures.push({
      invariant,
      reason: `literal invariant "${invariant.value}" is missing; semantic paraphrase is not accepted`,
      evidence: resolvedFilenameFiles.map((file) => file.relativePath),
    });
  }

  return {
    passed: failures.length === 0,
    checked: input.registry.invariants,
    failures,
  };
}

export function summarizeExactInvariantFailure(result: ExactInvariantCheckResult): string | null {
  if (result.passed) {
    return null;
  }
  const hasAmbiguousBinding = result.failures.some((failure) =>
    failure.reason.includes(`[${AMBIGUOUS_LITERAL_BINDING_STATUS}]`),
  );
  const details = result.failures.map(
    (failure) => `${failure.invariant.kind} "${failure.invariant.value}": ${failure.reason}`,
  );
  const status = hasAmbiguousBinding
    ? AMBIGUOUS_LITERAL_BINDING_STATUS
    : EXACT_INSTRUCTION_DRIFT_STATUS;
  return `[${status}] ${details.join('; ')}`;
}

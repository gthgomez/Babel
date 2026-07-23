import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  buildUntrustedContentBlock,
  untrustedContentInstruction,
} from '../utils/untrustedContent.js';
import { redactSecrets } from '../utils/redaction.js';

export type ContextRefKind = 'file' | 'directory';

export interface ContextAttachment {
  ref: string;
  kind: ContextRefKind;
  requested_path: string;
  resolved_path: string;
  project_relative_path: string;
  status: 'included' | 'partial' | 'skipped';
  bytes: number;
  files: Array<{
    path: string;
    bytes: number;
    content: string;
    truncated: boolean;
  }>;
  skipped: Array<{
    path: string;
    reason: string;
  }>;
}

export interface ContextInjectionResult {
  schema_version: 1;
  generated_at: string;
  project_root: string;
  original_task: string;
  task: string;
  attachments: ContextAttachment[];
  notes: string[];
}

export interface ContextInjectionOptions {
  projectRoot: string;
  maxFilesPerDirectory?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

interface ParsedRef {
  ref: string;
  kind: ContextRefKind;
  path: string;
}

const DEFAULT_MAX_FILES_PER_DIRECTORY = 20;
const DEFAULT_MAX_FILE_BYTES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 80_000;

const EXCLUDED_DIRS = new Set([
  '.git',
  '.gradle',
  '.next',
  '.pytest_cache',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'runs',
]);

const CONTEXT_REF_RE = /@(file|directory)(?::|=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g;

function normalizeForDisplay(value: string): string {
  return value.replace(/\\/g, '/');
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeResolve(projectRoot: string, requestedPath: string): string {
  const resolved = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(projectRoot, requestedPath);
  if (!isWithinRoot(projectRoot, resolved)) {
    throw new Error(`Context path escapes project root: ${requestedPath}`);
  }
  return resolved;
}

function parseContextRefs(task: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  for (const match of task.matchAll(CONTEXT_REF_RE)) {
    const kind = match[1] as ContextRefKind;
    const requestedPath = match[2] ?? match[3] ?? match[4];
    if (!requestedPath) {
      continue;
    }
    refs.push({
      ref: match[0],
      kind,
      path: requestedPath,
    });
  }
  return refs;
}

function isGitIgnored(projectRoot: string, absolutePath: string): boolean {
  const rel = normalizeForDisplay(relative(projectRoot, absolutePath));
  if (!rel || rel.startsWith('../')) {
    return true;
  }
  const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', rel], {
    cwd: projectRoot,
    windowsHide: true,
  });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  const gitignorePath = join(projectRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return false;
  }
  const patterns = readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/\\/g, '/');
    if (normalized.endsWith('/')) {
      return rel === normalized.slice(0, -1) || rel.startsWith(normalized);
    }
    return rel === normalized || rel.endsWith(`/${normalized}`);
  });
}

function looksBinary(content: Buffer): boolean {
  return content.includes(0);
}

function readTextFile(
  projectRoot: string,
  filePath: string,
  maxFileBytes: number,
): { path: string; bytes: number; content: string; truncated: boolean } | { skipped: string } {
  if (isGitIgnored(projectRoot, filePath)) {
    return { skipped: 'git_ignored' };
  }
  const stats = statSync(filePath);
  if (!stats.isFile()) {
    return { skipped: 'not_regular_file' };
  }
  const buffer = readFileSync(filePath);
  if (looksBinary(buffer)) {
    return { skipped: 'binary_file' };
  }
  const truncated = buffer.byteLength > maxFileBytes;
  const limited = truncated ? buffer.subarray(0, maxFileBytes) : buffer;
  const rawContent = limited.toString('utf8');
  return {
    path: normalizeForDisplay(relative(projectRoot, filePath)),
    bytes: buffer.byteLength,
    content: redactSecrets(rawContent),
    truncated,
  };
}

function collectDirectoryFiles(
  root: string,
  maxFiles: number,
): Array<{ path: string; skipped?: string }> {
  const files: Array<{ path: string; skipped?: string }> = [];

  function walk(dir: string): void {
    if (files.filter((item) => !item.skipped).length >= maxFiles) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (lstatSync(fullPath).isDirectory()) {
        // Case-insensitive exclusion for cross-platform safety.
        if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          walk(fullPath);
        }
        continue;
      }
      // Skip symbolic links / junctions to prevent traversal outside the project root.
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isFile()) {
        files.push({ path: fullPath });
      }
      if (files.filter((item) => !item.skipped).length >= maxFiles) {
        return;
      }
    }
  }

  walk(root);
  return files;
}

function buildPromptBlock(attachments: ContextAttachment[]): string {
  if (attachments.length === 0) {
    return '';
  }
  const parts: string[] = [];
  parts.push('');
  parts.push(untrustedContentInstruction('ATTACHED_CONTEXT'));

  for (const attachment of attachments) {
    const header = `Source: ${attachment.ref} -> ${attachment.project_relative_path}`;
    const fileBlocks: string[] = [];

    for (const file of attachment.files) {
      const label = `FILE_${file.path.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
      const prefix = file.truncated ? `${file.path} (truncated)\n` : `${file.path}\n`;
      // Escape triple-backtick sequences that could prematurely close the
      // untrusted content block delimiter in downstream rendering.
      const escapedContent = file.content.replace(/```/g, '\\`\\`\\`');
      fileBlocks.push(prefix + buildUntrustedContentBlock(label, escapedContent));
    }
    for (const skipped of attachment.skipped) {
      fileBlocks.push(`Skipped: ${skipped.path} (${skipped.reason})`);
    }

    if (fileBlocks.length > 0) {
      parts.push(header + '\n' + fileBlocks.join('\n'));
    }
  }

  return parts.join('\n');
}

export function prepareContextInjection(
  task: string,
  options: ContextInjectionOptions,
): ContextInjectionResult {
  const projectRoot = resolve(options.projectRoot);
  const maxFilesPerDirectory = options.maxFilesPerDirectory ?? DEFAULT_MAX_FILES_PER_DIRECTORY;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const notes: string[] = [];
  let totalBytes = 0;

  const attachments = parseContextRefs(task).map((ref): ContextAttachment => {
    const resolvedPath = safeResolve(projectRoot, ref.path);
    const relPath = normalizeForDisplay(relative(projectRoot, resolvedPath));
    const base: ContextAttachment = {
      ref: ref.ref,
      kind: ref.kind,
      requested_path: ref.path,
      resolved_path: resolvedPath,
      project_relative_path: relPath,
      status: 'skipped',
      bytes: 0,
      files: [],
      skipped: [],
    };

    if (!existsSync(resolvedPath)) {
      base.skipped.push({ path: relPath, reason: 'missing' });
      return base;
    }

    const stats = statSync(resolvedPath);
    const candidates =
      ref.kind === 'file'
        ? [{ path: resolvedPath }]
        : stats.isDirectory()
          ? collectDirectoryFiles(resolvedPath, maxFilesPerDirectory)
          : [{ path: resolvedPath, skipped: 'not_directory' }];

    for (const candidate of candidates) {
      const candidateRel = normalizeForDisplay(relative(projectRoot, candidate.path));
      if (candidate.skipped) {
        base.skipped.push({ path: candidateRel, reason: candidate.skipped });
        continue;
      }
      if (totalBytes >= maxTotalBytes) {
        base.skipped.push({ path: candidateRel, reason: 'context_total_byte_limit' });
        continue;
      }
      const file = readTextFile(
        projectRoot,
        candidate.path,
        Math.min(maxFileBytes, maxTotalBytes - totalBytes),
      );
      if ('skipped' in file) {
        base.skipped.push({ path: candidateRel, reason: file.skipped });
        continue;
      }
      totalBytes += Buffer.byteLength(file.content, 'utf8');
      base.bytes += file.bytes;
      base.files.push(file);
    }

    base.status =
      base.files.length > 0 && base.skipped.length > 0
        ? 'partial'
        : base.files.length > 0
          ? 'included'
          : 'skipped';
    return base;
  });

  if (attachments.some((attachment) => attachment.status === 'partial')) {
    notes.push(
      'Some context attachments were partially included because filtering or size limits applied.',
    );
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    original_task: task,
    task: `${task}${buildPromptBlock(attachments)}`,
    attachments,
    notes,
  };
}

export function writeContextInjectionEvidence(
  runDir: string,
  result: ContextInjectionResult,
): void {
  if (result.attachments.length === 0) {
    return;
  }
  const target = join(runDir, '00_context_injections.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export function summarizeContextInjection(result: ContextInjectionResult): string {
  const includedFiles = result.attachments.reduce(
    (sum, attachment) => sum + attachment.files.length,
    0,
  );
  const skippedFiles = result.attachments.reduce(
    (sum, attachment) => sum + attachment.skipped.length,
    0,
  );
  return `${result.attachments.length} attachment(s), ${includedFiles} file(s) included, ${skippedFiles} skipped`;
}

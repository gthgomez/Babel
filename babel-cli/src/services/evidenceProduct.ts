/**
 * W3.2 — Evidence product: open + export
 *
 * S-EV-01 evidence open: summarize a run dir for fast failure diagnosis.
 * S-EV-02 export bundle: copy key artifacts + manifest into an export folder
 * (zip when platform zip/tar is available; always writes a portable directory).
 */

import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readLatestRunPointer } from '../cli/helpers.js';
import { loadImplementorShipEvidenceFromArtifacts, loadImplementorShipEvidenceFromRunDir } from './shipEvidencePrBody.js';
import { loadEnterprisePolicy } from '../config/enterprisePolicy.js';
import { redactEvidenceValue, redactSecrets } from '../utils/redaction.js';
import { checkedFileBytes } from '../utils/checkedFileRead.js';

export interface EvidenceOpenReport {
  schema_version: 1;
  status: 'ok' | 'missing' | 'partial';
  run_dir: string | null;
  project?: string | null;
  summary: string[];
  key_files: Array<{ name: string; path: string; exists: boolean; bytes?: number }>;
  implementor: ReturnType<typeof loadImplementorShipEvidenceFromRunDir> | null;
  diagnose: string[];
  generated_at: string;
}

export interface EvidenceExportReport {
  schema_version: 1;
  status: 'ok' | 'failed';
  source_run_dir: string;
  export_dir: string;
  zip_path: string | null;
  files_copied: string[];
  manifest_path: string;
  error: string | null;
  generated_at: string;
}

const KEY_EVIDENCE_NAMES = [
  'harness.json',
  'policy-events.jsonl',
  'cli_payload.json',
  'intent_plan.json',
  'failure_card.md',
  'success_card.md',
  'verification.json',
  'response.md',
];

export function resolveEvidenceRunDir(input: {
  run?: string;
  project?: string;
  projectRoot?: string;
  lastRunDir?: string | null;
}): { ok: boolean; runDir: string | null; error: string | null; project?: string | null } {
  const raw = input.run?.trim();
  if (raw && raw !== 'latest') {
    const abs = resolve(raw);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return { ok: true, runDir: abs, error: null };
    }
    return { ok: false, runDir: null, error: `Run directory not found: ${raw}` };
  }

  if (input.lastRunDir && existsSync(input.lastRunDir)) {
    return { ok: true, runDir: resolve(input.lastRunDir), error: null };
  }

  const pointer = readLatestRunPointer(input.project);
  if (pointer?.run_dir && existsSync(pointer.run_dir)) {
    return {
      ok: true,
      runDir: resolve(pointer.run_dir),
      error: null,
      project: pointer.project ?? input.project ?? null,
    };
  }

  return {
    ok: false,
    runDir: null,
    error: 'No run directory resolved. Pass a path, use session last run, or run a task first.',
    project: input.project ?? null,
  };
}

function listKeyFiles(runDir: string): EvidenceOpenReport['key_files'] {
  const found: EvidenceOpenReport['key_files'] = [];
  for (const name of KEY_EVIDENCE_NAMES) {
    const p = join(runDir, name);
    const exists = existsSync(p);
    found.push({
      name,
      path: p,
      exists,
      ...(exists ? { bytes: statSync(p).size } : {}),
    });
  }
  // Also surface *-harness.json
  try {
    for (const f of readdirSync(runDir)) {
      if (f.endsWith('-harness.json') && !KEY_EVIDENCE_NAMES.includes(f)) {
        const p = join(runDir, f);
        found.push({ name: f, path: p, exists: true, bytes: statSync(p).size });
      }
    }
  } catch {
    // ignore
  }
  return found;
}

/**
 * Open (summarize) evidence for a run — diagnose last fail in < 2 min target.
 */
export function openEvidence(input: {
  run?: string;
  project?: string;
  lastRunDir?: string | null;
  now?: Date;
}): EvidenceOpenReport {
  const resolved = resolveEvidenceRunDir(input);
  const generated_at = (input.now ?? new Date()).toISOString();
  if (!resolved.ok || !resolved.runDir) {
    return {
      schema_version: 1,
      status: 'missing',
      run_dir: null,
      project: resolved.project ?? input.project ?? null,
      summary: [resolved.error ?? 'missing run'],
      key_files: [],
      implementor: null,
      diagnose: [
        'Run a chat/implement task first, or pass an explicit run directory.',
        'CLI: babel evidence open --run <path>',
        'CLI: babel inspect run latest',
      ],
      generated_at,
    };
  }

  const runDir = resolved.runDir;
  const key_files = listKeyFiles(runDir);
  const implementor = loadImplementorShipEvidenceFromRunDir(runDir);
  const present = key_files.filter((k) => k.exists).map((k) => k.name);
  const summary: string[] = [
    `Run: ${runDir}`,
    `Key artifacts present: ${present.length ? present.join(', ') : '(none of standard set)'}`,
  ];
  if (implementor.status) summary.push(`Harness status: ${implementor.status}`);
  if (implementor.write_count != null) summary.push(`Write count: ${implementor.write_count}`);
  if (implementor.env_blocked) summary.push('ENV_BLOCKED: yes (toolchain, not policy thrash)');
  if (implementor.phase_gate_write_block_count != null) {
    summary.push(`Phase-gate write blocks: ${implementor.phase_gate_write_block_count}`);
  }

  const diagnose: string[] = [];
  if (implementor.env_blocked) {
    diagnose.push('Install/fix runtime tools, then re-run verifier — do not score as empty_patch.');
  }
  if ((implementor.write_count ?? 0) === 0 && implementor.status && implementor.status !== 'ENV_BLOCKED') {
    diagnose.push('Zero writes — check /why-stopped, force_mutate, phase-gate, shell thrash.');
  }
  if ((implementor.phase_gate_write_block_count ?? 0) > 0) {
    diagnose.push('Phase-gate blocked writes — confirm phase advanced to mutate or disable gate for execute tasks.');
  }
  if (diagnose.length === 0) {
    diagnose.push('Evidence looks complete enough for PR body — try /ship (dry-run) or babel ship.');
  }

  const status: EvidenceOpenReport['status'] =
    present.length === 0 ? 'partial' : present.includes('harness.json') || present.some((n) => n.endsWith('-harness.json'))
      ? 'ok'
      : 'partial';

  return {
    schema_version: 1,
    status,
    run_dir: runDir,
    project: resolved.project ?? input.project ?? null,
    summary,
    key_files,
    implementor,
    diagnose,
    generated_at,
  };
}

export function formatEvidenceOpenHuman(report: EvidenceOpenReport): string {
  const lines = [
    'Babel Evidence Open',
    `Status: ${report.status}`,
    report.run_dir ? `Run: ${report.run_dir}` : 'Run: (none)',
    '',
    'Summary:',
    ...report.summary.map((s) => `- ${s}`),
    '',
    'Key files:',
    ...report.key_files.map(
      (k) => `- ${k.exists ? '✓' : '·'} ${k.name}${k.bytes != null ? ` (${k.bytes} B)` : ''}`,
    ),
    '',
    'Diagnose:',
    ...report.diagnose.map((d) => `- ${d}`),
  ];
  return lines.join('\n');
}

/**
 * Export evidence into a portable directory (+ zip when possible).
 */
export function exportEvidenceBundle(input: {
  runDir: string;
  outputDir?: string;
  now?: Date;
}): EvidenceExportReport {
  const now = input.now ?? new Date();
  const source = resolve(input.runDir);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const exportRoot = resolve(input.outputDir ?? join(dirname(source), `evidence-export-${stamp}`));
  return {
    schema_version: 1,
    status: 'failed',
    source_run_dir: source,
    export_dir: exportRoot,
    zip_path: null,
    files_copied: [],
    manifest_path: join(exportRoot, 'export-manifest.json'),
    error: 'Evidence export is temporarily unavailable until source and destination directories can be held stable throughout export. Existing evidence is retained.',
    generated_at: now.toISOString(),
  };
}

/** Retained repair candidate; not exposed while directory ownership is unqualified. */
function exportEvidenceBundleUnqualified(input: {
  runDir: string;
  outputDir?: string;
  now?: Date;
}): EvidenceExportReport {
  const now = input.now ?? new Date();
  const source = resolve(input.runDir);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const exportRoot = resolve(
    input.outputDir ?? join(dirname(source), `evidence-export-${stamp}`),
  );
  const files_copied: string[] = [];
  const generated_at = now.toISOString();

  if (!existsSync(source) || !statSync(source).isDirectory()) {
    return {
      schema_version: 1,
      status: 'failed',
      source_run_dir: source,
      export_dir: exportRoot,
      zip_path: null,
      files_copied: [],
      manifest_path: join(exportRoot, 'export-manifest.json'),
      error: `Source run dir missing: ${source}`,
      generated_at,
    };
  }

  try {
    const assertPhysicalDirectoryPath = (path: string): void => {
      let ancestor = path;
      while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
      const stat = lstatSync(ancestor);
      const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
      if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(realpathSync(ancestor)) !== normalize(resolve(ancestor))) {
        throw new Error('Evidence export refused a linked directory path.');
      }
    };
    assertPhysicalDirectoryPath(source);
    assertPhysicalDirectoryPath(exportRoot);
    // Reject linked artifacts before reading or copying any source content.
    for (const name of readdirSync(source)) {
      const entry = lstatSync(join(source, name));
      if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink !== 1)) {
        throw new Error('Evidence export refused a linked source artifact.');
      }
    }
    const policy = loadEnterprisePolicy().policy;
    const exportPolicy = { ...policy, redaction: { ...policy.redaction, enabled: true } };
    const omitPromptPayloads = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(omitPromptPayloads);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        /^(?:prompt|systemprompt|messages|compiledcontext|tooloutput)$/.test(key.replace(/[_-]/g, '').toLowerCase()) ? '[OMITTED]' : omitPromptPayloads(item)]));
    };
    const archiveContent = new Map<string, string>();
    let archiveBytes = 0;
    const copySanitized = (from: string, to: string): string => {
      const exact = lstatSync(from, { bigint: true });
      const stat = lstatSync(from);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2_000_000) throw new Error('Evidence artifact is not a bounded regular file.');
      const bytes = checkedFileBytes(from, 2_000_000, () => {
        try { assertPhysicalDirectoryPath(source); return true; } catch { return false; }
      }, stat, exact);
      if (!bytes) throw new Error('Evidence artifact changed or could not be safely read.');
      const text = bytes.toString('utf8');
      let output: string;
      if (from.toLowerCase().endsWith('.json')) {
        output = `${JSON.stringify(redactEvidenceValue(omitPromptPayloads(JSON.parse(text)), exportPolicy), null, 2)}\n`;
      } else if (from.toLowerCase().endsWith('.jsonl')) {
        output = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.stringify(redactEvidenceValue(omitPromptPayloads(JSON.parse(line)), exportPolicy))).join('\n') + '\n';
      } else {
        output = redactSecrets(text, exportPolicy);
      }
      writeFileSync(to, output, { encoding: 'utf8', flag: 'wx' });
      return output;
    };
    mkdirSync(exportRoot, { recursive: true });
    assertPhysicalDirectoryPath(exportRoot);
    if (readdirSync(exportRoot).length !== 0) {
      throw new Error('Evidence export requires an empty destination directory.');
    }
    const key = listKeyFiles(source).filter((k) => k.exists);
    for (const k of key) {
      const dest = join(exportRoot, k.name);
      const sanitized = copySanitized(k.path, dest);
      archiveBytes += Buffer.byteLength(sanitized, 'utf8');
      if (archiveBytes > 32_000_000) throw new Error('Evidence export exceeds the bounded archive size.');
      archiveContent.set(k.name, sanitized);
      files_copied.push(k.name);
    }

    const omittedUnselectedCount = readdirSync(source).filter(name => /\.(json|jsonl|md)$/i.test(name) && !files_copied.includes(name)).length;

    // Derive metadata from sanitized bytes without reopening mutable paths.
    const implementor = loadImplementorShipEvidenceFromArtifacts(archiveContent);
    const manifest_path = join(exportRoot, 'export-manifest.json');
    const manifestText = `${JSON.stringify(
        {
          schema_version: 1,
          kind: 'babel_evidence_export',
          source_run_id: basename(source),
          generated_at,
          files: files_copied,
          omitted_unselected_count: omittedUnselectedCount,
          implementor: redactEvidenceValue(implementor, exportPolicy),
        },
        null,
        2,
      )}\n`;
    writeFileSync(manifest_path, manifestText, { encoding: 'utf8', flag: 'wx' });
    archiveContent.set('export-manifest.json', manifestText);
    if (!files_copied.includes('export-manifest.json')) {
      files_copied.push('export-manifest.json');
    }

    const zip_path = tryCreateZip(join(dirname(exportRoot), `${basename(exportRoot)}.zip`), archiveContent);

    return {
      schema_version: 1,
      status: 'ok',
      source_run_dir: source,
      export_dir: exportRoot,
      zip_path,
      files_copied,
      manifest_path,
      error: null,
      generated_at,
    };
  } catch (err) {
    return {
      schema_version: 1,
      status: 'failed',
      source_run_dir: source,
      export_dir: exportRoot,
      zip_path: null,
      files_copied,
      manifest_path: join(exportRoot, 'export-manifest.json'),
      error: err instanceof Error ? err.message : String(err),
      generated_at,
    };
  }
}

export function formatEvidenceExportHuman(report: EvidenceExportReport): string {
  const lines = [
    'Babel Evidence Export',
    `Status: ${report.status}`,
    `Source: ${report.source_run_dir}`,
    `Export dir: ${report.export_dir}`,
    report.zip_path ? `Zip: ${report.zip_path}` : report.status === 'ok' ? 'Zip: (not created — directory export is complete)' : 'Zip: (not created)',
    `Files: ${report.files_copied.length}`,
    ...report.files_copied.slice(0, 30).map((f) => `- ${f}`),
  ];
  if (report.error) lines.push(`Error: ${report.error}`);
  return lines.join('\n');
}

function tryCreateZip(zipPath: string, contents: ReadonlyMap<string, string>): string | null {
  if (existsSync(zipPath)) return null;
  const scratch = mkdtempSync(join(tmpdir(), 'babel-evidence-archive-'));
  const temporaryZip = join(scratch, 'bundle.zip');
  try {
  const stagedDir = join(scratch, 'content');
  mkdirSync(stagedDir);
  for (const [name, content] of contents) writeFileSync(join(stagedDir, name), content, { encoding: 'utf8', flag: 'wx' });
  const files = [...contents.keys()];
  // Prefer tar (git bash / unix); fall back to PowerShell Compress-Archive on Windows.
  const tar = spawnSync('tar', ['-a', '-cf', temporaryZip, '-C', scratch, ...files.map(name => `./content/${name}`)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (tar.status !== 0 && process.platform !== 'win32') return null;
  if (tar.status !== 0 && process.platform === 'win32') {
    rmSync(temporaryZip, { force: true });
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath @(${files.map(name => `'${join(stagedDir, name).replace(/'/g, "''")}'`).join(',')}) -DestinationPath '${temporaryZip.replace(/'/g, "''")}'`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (ps.status !== 0) return null;
  }
  if (!existsSync(temporaryZip)) return null;
  try { copyFileSync(temporaryZip, zipPath, constants.COPYFILE_EXCL); return zipPath; }
  catch { return null; }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Relative path helper for tests. */
export function evidenceRelative(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, '/');
}

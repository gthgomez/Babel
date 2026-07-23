/**
 * W3.2 — Evidence product: open + export
 *
 * S-EV-01 evidence open: summarize a run dir for fast failure diagnosis.
 * S-EV-02 export bundle: copy key artifacts + manifest into an export folder
 * (zip when platform zip/tar is available; always writes a portable directory).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readLatestRunPointer } from '../cli/helpers.js';
import { loadImplementorShipEvidenceFromRunDir } from './shipEvidencePrBody.js';

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
    mkdirSync(exportRoot, { recursive: true });
    const key = listKeyFiles(source).filter((k) => k.exists);
    for (const k of key) {
      const dest = join(exportRoot, k.name);
      copyFileSync(k.path, dest);
      files_copied.push(k.name);
    }

    // Copy shallow jsonl/json evidence (cap count)
    let extra = 0;
    for (const name of readdirSync(source)) {
      if (extra >= 20) break;
      if (files_copied.includes(name)) continue;
      if (!/\.(json|jsonl|md)$/i.test(name)) continue;
      const src = join(source, name);
      if (!statSync(src).isFile()) continue;
      if (statSync(src).size > 2_000_000) continue;
      copyFileSync(src, join(exportRoot, name));
      files_copied.push(name);
      extra += 1;
    }

    const implementor = loadImplementorShipEvidenceFromRunDir(source);
    const manifest_path = join(exportRoot, 'export-manifest.json');
    writeFileSync(
      manifest_path,
      `${JSON.stringify(
        {
          schema_version: 1,
          kind: 'babel_evidence_export',
          source_run_dir: source,
          generated_at,
          files: files_copied,
          implementor,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    if (!files_copied.includes('export-manifest.json')) {
      files_copied.push('export-manifest.json');
    }

    const zip_path = tryCreateZip(exportRoot, join(dirname(exportRoot), `${basename(exportRoot)}.zip`));

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
    report.zip_path ? `Zip: ${report.zip_path}` : 'Zip: (not created — directory export is complete)',
    `Files: ${report.files_copied.length}`,
    ...report.files_copied.slice(0, 30).map((f) => `- ${f}`),
  ];
  if (report.error) lines.push(`Error: ${report.error}`);
  return lines.join('\n');
}

function tryCreateZip(dir: string, zipPath: string): string | null {
  // Prefer tar (git bash / unix); fall back to PowerShell Compress-Archive on Windows.
  const tar = spawnSync('tar', ['-a', '-cf', zipPath, '-C', dirname(dir), basename(dir)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (tar.status === 0 && existsSync(zipPath)) return zipPath;

  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (ps.status === 0 && existsSync(zipPath)) return zipPath;
  }

  return null;
}

/** Relative path helper for tests. */
export function evidenceRelative(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, '/');
}

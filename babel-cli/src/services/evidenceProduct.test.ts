import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  exportEvidenceBundle,
  formatEvidenceOpenHuman,
  openEvidence,
  resolveEvidenceRunDir,
} from './evidenceProduct.js';

describe('evidenceProduct (W3.2)', () => {
  test('openEvidence missing without run', () => {
    const report = openEvidence({ run: join(tmpdir(), 'definitely-missing-babel-run') });
    assert.equal(report.status, 'missing');
    assert.ok(formatEvidenceOpenHuman(report).includes('Evidence Open'));
  });

  test('openEvidence + exportEvidenceBundle for a fixture run dir', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-ev-run-'));
    writeFileSync(
      join(runDir, 'harness.json'),
      JSON.stringify({
        status: 'ENV_BLOCKED',
        write_count: 0,
        env_blocked: true,
        phase_gate_write_block_count: 1,
        task: 'fix x',
      }),
      'utf8',
    );
    writeFileSync(join(runDir, 'policy-events.jsonl'), '{"kind":"phase_gate_block"}\n', 'utf8');

    const opened = openEvidence({ run: runDir });
    assert.equal(opened.status, 'ok');
    assert.equal(opened.run_dir, runDir);
    assert.ok(
      opened.diagnose.some(
        (d) => /env|toolchain|empty_patch|verifier/i.test(d),
      ),
      opened.diagnose.join('; '),
    );

    const outDir = join(runDir, 'export-out');
    const exported = exportEvidenceBundle({ runDir, outputDir: outDir });
    assert.equal(exported.status, 'ok', exported.error ?? '');
    assert.ok(exported.files_copied.includes('harness.json'));
    assert.ok(exported.files_copied.includes('export-manifest.json'));
    const manifest = JSON.parse(readFileSync(exported.manifest_path, 'utf8')) as {
      kind: string;
    };
    assert.equal(manifest.kind, 'babel_evidence_export');
  });

  test('resolveEvidenceRunDir accepts explicit path', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-ev-res-'));
    mkdirSync(runDir, { recursive: true });
    const r = resolveEvidenceRunDir({ run: runDir });
    assert.equal(r.ok, true);
    assert.equal(r.runDir, runDir);
  });
});

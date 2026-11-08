import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  exportEvidenceBundle,
  formatEvidenceOpenHuman,
  openEvidence,
  resolveEvidenceRunDir,
} from './evidenceProduct.js';

describe('evidenceProduct (W3.2)', () => {
  test('default export does not copy unselected prompt artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-prompt-'));
    try {
      const runDir = join(root, 'run'); const outputDir = join(root, 'export'); mkdirSync(runDir);
      writeFileSync(join(runDir, 'verification.json'), JSON.stringify({ status: 'passed', nested: { systemPrompt: 'SYNTHETIC_PRIVATE_PROMPT' } }));
      writeFileSync(join(runDir, 'private-prompt.json'), JSON.stringify({ prompt: 'SYNTHETIC_PRIVATE_PROMPT' }));
      const result = exportEvidenceBundle({ runDir, outputDir });
      assert.equal(result.status, 'ok');
      assert.equal(existsSync(join(outputDir, 'verification.json')), true);
      for (const name of result.files_copied) assert.equal(readFileSync(join(outputDir, name), 'utf8').includes('SYNTHETIC_PRIVATE_PROMPT'), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('malformed JSON fails export without reflecting its private contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-malformed-'));
    try {
      const runDir = join(root, 'run'); mkdirSync(runDir);
      writeFileSync(join(runDir, 'harness.json'), '{"private":"SYNTHETIC_PRIVATE_MALFORMED",}');
      const result = exportEvidenceBundle({ runDir, outputDir: join(root, 'export') });
      assert.equal(result.status, 'failed');
      assert.equal(JSON.stringify(result).includes('SYNTHETIC_'), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('export refuses a junction inside the source run', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-junction-'));
    try {
      const runDir = join(root, 'run'); const outside = join(root, 'outside');
      mkdirSync(runDir); mkdirSync(outside);
      symlinkSync(outside, join(runDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const result = exportEvidenceBundle({ runDir, outputDir: join(root, 'export') });
      assert.equal(result.status, 'failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('export refuses to overwrite an existing linked destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-destination-'));
    try {
      const runDir = join(root, 'run');
      const outputDir = join(root, 'export');
      mkdirSync(runDir); mkdirSync(outputDir);
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'SYNTHETIC_PRESERVED_DESTINATION');
      linkSync(outside, join(outputDir, 'response.md'));
      writeFileSync(join(runDir, 'response.md'), 'export contents');
      const result = exportEvidenceBundle({ runDir, outputDir });
      assert.equal(result.status, 'failed');
      assert.equal(readFileSync(outside, 'utf8'), 'SYNTHETIC_PRESERVED_DESTINATION');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('export refuses a linked destination directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-destination-junction-'));
    try {
      const runDir = join(root, 'run'); const outside = join(root, 'outside'); const outputDir = join(root, 'export');
      mkdirSync(runDir); mkdirSync(outside); writeFileSync(join(runDir, 'response.md'), 'safe fixture');
      symlinkSync(outside, outputDir, process.platform === 'win32' ? 'junction' : 'dir');
      const result = exportEvidenceBundle({ runDir, outputDir });
      assert.equal(result.status, 'failed');
      assert.equal(existsSync(join(outside, 'response.md')), false);
      assert.equal(existsSync(join(outside, 'export-manifest.json')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('export refuses linked source roots and destination ancestors', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-root-junction-'));
    try {
      const runDir = join(root, 'run'); const outside = join(root, 'outside'); mkdirSync(runDir); mkdirSync(outside);
      writeFileSync(join(runDir, 'response.md'), 'safe fixture');
      const linkedRun = join(root, 'linked-run'); const linkedOutputParent = join(root, 'linked-output');
      symlinkSync(runDir, linkedRun, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkSync(outside, linkedOutputParent, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(exportEvidenceBundle({ runDir: linkedRun, outputDir: join(root, 'export') }).status, 'failed');
      assert.equal(exportEvidenceBundle({ runDir, outputDir: join(linkedOutputParent, 'child') }).status, 'failed');
      assert.equal(existsSync(join(outside, 'child')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('export redacts credential fields from copied JSON and its manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-secret-'));
    try {
      const runDir = join(root, 'run');
      const outputDir = join(root, 'export');
      mkdirSync(runDir);
      const canary = 'SYNTHETIC_PRIVATE_VALUE_FOR_EXPORT';
      writeFileSync(join(runDir, 'harness.json'), JSON.stringify({ task: 'safe task', authorization: canary }));
      const result = exportEvidenceBundle({ runDir, outputDir });
      assert.equal(result.status, 'ok');
      for (const name of result.files_copied) assert.equal(readFileSync(join(outputDir, name), 'utf8').includes(canary), false);
      assert.equal(JSON.parse(readFileSync(join(outputDir, 'harness.json'), 'utf8')).task, 'safe task');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('export omits a private Plan and redacts a copied credential-shaped response', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-plan-private-'));
    try {
      const runDir = join(root, 'run'); const outputDir = join(root, 'export'); mkdirSync(runDir);
      const canary = 'SYNTHETIC_PLAN_EXPORT_SECRET'; const body = `OPENAI_API_KEY=${canary}`;
      writeFileSync(join(runDir, 'plan.md'), body); writeFileSync(join(runDir, 'response.md'), `Safe preface\n${body}\n`);
      const result = exportEvidenceBundle({ runDir, outputDir });
      assert.equal(result.status, 'ok'); assert.ok(result.files_copied.includes('response.md'));
      assert.equal(result.files_copied.includes('plan.md'), false);
      for (const name of result.files_copied) assert.equal(readFileSync(join(outputDir, name), 'utf8').includes(canary), false);
      assert.match(readFileSync(join(outputDir, 'response.md'), 'utf8'), /Safe preface/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('export does not copy a hard-linked outside artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-export-link-'));
    try {
      const runDir = join(root, 'run');
      const outputDir = join(root, 'export');
      mkdirSync(runDir);
      writeFileSync(join(root, 'outside.txt'), 'SYNTHETIC_EXPORT_FORBIDDEN');
      linkSync(join(root, 'outside.txt'), join(runDir, 'response.md'));
      writeFileSync(join(runDir, 'verification.json'), '{"ok":true}');
      const result = exportEvidenceBundle({ runDir, outputDir });
      assert.equal(result.status, 'failed');
      assert.equal(existsSync(join(outputDir, 'response.md')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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
      source_run_id: string;
    };
    assert.equal(manifest.kind, 'babel_evidence_export');
    assert.equal(manifest.source_run_id, basename(runDir));
    assert.equal(readFileSync(exported.manifest_path, 'utf8').includes(runDir), false, 'export must not expose the private source directory');
  });

  test('resolveEvidenceRunDir accepts explicit path', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-ev-res-'));
    mkdirSync(runDir, { recursive: true });
    const r = resolveEvidenceRunDir({ run: runDir });
    assert.equal(r.ok, true);
    assert.equal(r.runDir, runDir);
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MaintenanceAuditReportSchema,
  formatMaintenanceAuditHuman,
  runMaintenanceAudit,
} from './maintenanceAudit.js';

function makeTempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-maintenance-audit-'));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function write(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function writeBaseline(root: string): void {
  write(root, 'README.md', '# Temp Repo\n\nSee [context](PROJECT_CONTEXT.md).\n');
  write(root, 'PROJECT_CONTEXT.md', '# Context\n');
  write(root, 'AGENTS.md', '# Agents\n');
  write(
    root,
    'babel-cli/source-provenance.json',
    JSON.stringify(
      {
        version: 1,
        allowed_js_source_files: [],
      },
      null,
      2,
    ),
  );
}

test('maintenance audit report schema captures deterministic hotspots', () => {
  const fixture = makeTempRepo();
  try {
    writeBaseline(fixture.root);
    write(
      fixture.root,
      'babel-cli/src/large.ts',
      Array.from({ length: 1005 }, (_, index) => `export const value${index} = ${index};`).join(
        '\n',
      ),
    );

    const report = runMaintenanceAudit({ repoRoot: fixture.root, all: true });

    assert.equal(MaintenanceAuditReportSchema.safeParse(report).success, true);
    assert.equal(report.proof.no_model_call, true);
    assert.equal(report.proof.docs_audit_status, 'pass');
    assert.ok(
      report.findings.some(
        (finding) =>
          finding.category === 'oversized_file' && finding.path === 'babel-cli/src/large.ts',
      ),
    );
    assert.match(formatMaintenanceAuditHuman(report), /Babel Simplify Audit/);
  } finally {
    fixture.cleanup();
  }
});

test('maintenance audit flags fixture-like JS leaked into production src', () => {
  const fixture = makeTempRepo();
  try {
    writeBaseline(fixture.root);
    write(fixture.root, 'babel-cli/src/math.js', 'export const add = (a, b) => a + b;\n');

    const report = runMaintenanceAudit({ repoRoot: fixture.root, all: true });

    assert.equal(report.status, 'fail');
    assert.equal(report.proof.source_provenance_status, 'fail');
    assert.ok(
      report.findings.some(
        (finding) => finding.category === 'fixture_leak' && finding.safe_to_apply,
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

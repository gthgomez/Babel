import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runDocsAudit } from './docsFitness.js';

function makeTempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-docs-audit-'));
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

function writeCleanDocs(root: string): void {
  write(root, 'README.md', '# Test Repo\n\nSee [context](PROJECT_CONTEXT.md).\n');
  write(root, 'PROJECT_CONTEXT.md', '# Project Context\n\nCurrent source-backed context.\n');
  write(root, 'AGENTS.md', '# Agent Guide\n\nRead order and risky paths.\n');
  write(root, 'QA_CHECKLIST.md', '# QA Checklist\n\n- npm test\n');
  write(
    root,
    'package.json',
    JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }, null, 2),
  );
}

test('docs audit passes for a clean small repo without manifest', () => {
  const fixture = makeTempRepo();
  try {
    writeCleanDocs(fixture.root);

    const report = runDocsAudit({ root: fixture.root });

    assert.equal(report.status, 'pass');
    assert.equal(report.manifestStatus.state, 'missing');
    assert.equal(report.summary.errors, 0);
    assert.equal(report.summary.warnings, 0);
    assert.ok(report.checkedDocs.some((doc) => doc.path === 'README.md'));
  } finally {
    fixture.cleanup();
  }
});

test('docs audit validates manifest, external commands, and generated authority conflicts', () => {
  const fixture = makeTempRepo();
  try {
    writeCleanDocs(fixture.root);
    write(fixture.root, 'artifacts/report.md', '# Generated Report\n');
    write(
      fixture.root,
      '.babel/docs-manifest.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          maintainedDocs: ['README.md', 'artifacts/report.md'],
          historicalDocs: [],
          generatedEvidence: ['artifacts/**'],
          trustedCommands: [
            {
              command: 'adb install app.apk',
              source: 'external',
              justification: 'Requires device',
            },
          ],
          highRiskPaths: ['src/auth/'],
          doNotUseAsAuthorityGlobs: ['artifacts/**'],
          maxLineBudgets: {},
        },
        null,
        2,
      ),
    );

    const report = runDocsAudit({ root: fixture.root });

    assert.equal(report.status, 'fail');
    assert.ok(report.findings.some((finding) => finding.code === 'generated.current_authority'));
    assert.equal(
      report.findings.some((finding) => finding.code === 'trusted_command.not_found'),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('docs audit flags broken relative links', () => {
  const fixture = makeTempRepo();
  try {
    writeCleanDocs(fixture.root);
    write(fixture.root, 'README.md', '# Test Repo\n\nSee [missing](docs/missing.md).\n');

    const report = runDocsAudit({ root: fixture.root });

    assert.equal(report.status, 'warn');
    assert.ok(report.findings.some((finding) => finding.code === 'link.missing_target'));
  } finally {
    fixture.cleanup();
  }
});

test('docs audit skips link checks for do-not-use authority globs', () => {
  const fixture = makeTempRepo();
  try {
    writeCleanDocs(fixture.root);
    write(fixture.root, 'tests/fixtures/response.md', '# Fixture\n\nSee [missing](missing.md).\n');
    write(
      fixture.root,
      '.babel/docs-manifest.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          maintainedDocs: ['README.md', 'PROJECT_CONTEXT.md', 'AGENTS.md'],
          historicalDocs: [],
          generatedEvidence: [],
          trustedCommands: [],
          highRiskPaths: [],
          doNotUseAsAuthorityGlobs: ['tests/fixtures/**'],
          maxLineBudgets: {},
        },
        null,
        2,
      ),
    );

    const report = runDocsAudit({ root: fixture.root });

    assert.equal(report.status, 'pass');
    assert.ok(
      report.checkedDocs.some(
        (doc) =>
          doc.path === 'tests/fixtures/response.md' &&
          doc.classification === 'DO_NOT_USE_AS_AUTHORITY',
      ),
    );
    assert.equal(
      report.findings.some((finding) => finding.code === 'link.missing_target'),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('docs audit ignores markdown-looking links in fenced code and accepts in-repo absolute Windows links', () => {
  const fixture = makeTempRepo();
  try {
    writeCleanDocs(fixture.root);
    const absoluteContext = join(fixture.root, 'PROJECT_CONTEXT.md').replace(/\\/g, '/');
    write(
      fixture.root,
      'README.md',
      [
        '# Test Repo',
        '',
        `See [context](/${absoluteContext}).`,
        '',
        '```ts',
        'const pattern = /\\[[^\\]]+\\]\\([^)]+\\)/;',
        '```',
        '',
      ].join('\n'),
    );

    const report = runDocsAudit({ root: fixture.root });

    assert.equal(report.status, 'pass');
    assert.equal(
      report.findings.some((finding) => finding.code.startsWith('link.')),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('docs audit flags over-budget agent docs without justification', () => {
  const fixture = makeTempRepo();
  try {
    writeCleanDocs(fixture.root);
    write(
      fixture.root,
      'AGENTS.md',
      Array.from({ length: 181 }, (_, index) => `line ${index + 1}`).join('\n'),
    );

    const report = runDocsAudit({ root: fixture.root });

    assert.equal(report.status, 'warn');
    assert.ok(report.findings.some((finding) => finding.code === 'line_budget.exceeded'));
  } finally {
    fixture.cleanup();
  }
});

test('docs audit checks historical headers and trusted package commands', () => {
  const fixture = makeTempRepo();
  try {
    writeCleanDocs(fixture.root);
    write(fixture.root, 'docs/old.md', '# Old Plan\n');
    write(
      fixture.root,
      '.babel/docs-manifest.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          maintainedDocs: ['README.md'],
          historicalDocs: ['docs/old.md'],
          generatedEvidence: [],
          trustedCommands: ['npm run missing'],
          highRiskPaths: [],
          doNotUseAsAuthorityGlobs: [],
          maxLineBudgets: {},
        },
        null,
        2,
      ),
    );

    const report = runDocsAudit({ root: fixture.root });

    assert.equal(report.status, 'warn');
    assert.ok(report.findings.some((finding) => finding.code === 'historical_doc.missing_header'));
    assert.ok(report.findings.some((finding) => finding.code === 'trusted_command.not_found'));
  } finally {
    fixture.cleanup();
  }
});

test('docs audit flags obvious secrets without printing the secret value', () => {
  const fixture = makeTempRepo();
  try {
    writeCleanDocs(fixture.root);
    write(fixture.root, 'README.md', '# Test Repo\n\napi_key = abcdefghijklmnopqrstuvwxyz123456\n');

    const report = runDocsAudit({ root: fixture.root });
    const finding = report.findings.find((item) => item.code === 'secret.assignment_value');

    assert.equal(report.status, 'fail');
    assert.ok(finding);
    assert.doesNotMatch(finding?.message ?? '', /abcdefghijklmnopqrstuvwxyz/);
  } finally {
    fixture.cleanup();
  }
});

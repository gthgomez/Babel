import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSkill,
  exportSkillToCodex,
  validateSkillPath,
} from './skillForge.js';

test('createSkill scaffolds a GREEN experimental skill with required files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-skill-forge-'));
  try {
    const report = createSkill('Example Skill', root);

    assert.equal(report.status, 'ok');
    assert.equal(report.validation.verdict, 'GREEN');
    assert.equal(report.validation.manifest?.['id'], 'example-skill');
    assert.equal(report.validation.manifest?.['status'], 'experimental');
    assert.equal(report.evidence_report.files_created_changed.length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateSkillPath reports RED for missing required contracts and tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-skill-forge-'));
  const skill = join(root, 'skills', 'broken-skill');
  try {
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# Broken\n', 'utf8');
    writeFileSync(join(skill, 'skill.yaml'), [
      'id: broken-skill',
      'name: Broken Skill',
      'version: 0.1.0',
      'status: reviewed',
      'description: Broken on purpose.',
      'entrypoint: SKILL.md',
      'allowed_tools: []',
      'denied_tools: []',
      'inputs: contracts/input.schema.json',
      'outputs: contracts/output.schema.json',
      'tests: tests/',
      'owner: test',
      'created_at: 2026-04-29T00:00:00.000Z',
      'updated_at: 2026-04-29T00:00:00.000Z',
      '',
    ].join('\n'), 'utf8');

    const result = validateSkillPath(skill);

    assert.equal(result.status, 'fail');
    assert.equal(result.verdict, 'RED');
    assert.equal(result.issues.some(issue => issue.code === 'skill.missing_contracts'), true);
    assert.equal(result.issues.some(issue => issue.code === 'skill.missing_tests'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateSkillPath reports RED for invalid status and YELLOW for empty examples', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-skill-forge-'));
  try {
    const report = createSkill('Needs Review', root);
    const skill = report.skill_path;
    writeFileSync(join(skill, 'skill.yaml'), [
      'id: needs-review',
      'name: Needs Review',
      'version: 0.1.0',
      'status: draft',
      'description: Invalid status on purpose.',
      'entrypoint: SKILL.md',
      'allowed_tools: []',
      'denied_tools: []',
      'inputs: contracts/input.schema.json',
      'outputs: contracts/output.schema.json',
      'tests: tests/',
      'owner: test',
      'created_at: 2026-04-29T00:00:00.000Z',
      'updated_at: 2026-04-29T00:00:00.000Z',
      '',
    ].join('\n'), 'utf8');
    rmSync(join(skill, 'examples'), { recursive: true, force: true });

    const result = validateSkillPath(skill);

    assert.equal(result.verdict, 'RED');
    assert.equal(result.issues.some(issue => issue.code === 'manifest.invalid_status'), true);
    assert.equal(result.issues.some(issue => issue.code === 'skill.no_examples'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportSkillToCodex blocks experimental skills unless explicitly allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-skill-forge-'));
  const destination = mkdtempSync(join(tmpdir(), 'babel-codex-skills-'));
  try {
    createSkill('Export Candidate', root);

    const blocked = exportSkillToCodex('export-candidate', root, { destinationRoot: destination });
    assert.equal(blocked.status, 'fail');
    assert.match(blocked.evidence_report.next_recommended_action, /--allow-experimental/);

    const exported = exportSkillToCodex('export-candidate', root, {
      allowExperimental: true,
      destinationRoot: destination,
    });
    assert.equal(exported.status, 'ok');
    assert.equal(exported.evidence_report.files_created_changed.length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

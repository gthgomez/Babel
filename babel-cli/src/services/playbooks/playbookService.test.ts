import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlaybookPrompt,
  clearPlaybookCache,
  inferChatTaskSkills,
  loadPlaybooks,
  selectPlaybookBySkills,
  selectPlaybookForChatTask,
  type PlaybookDefinition,
} from './playbookService.js';

describe('playbookService (T3.1)', () => {
  const prev = process.env['BABEL_CHAT_PLAYBOOKS'];

  beforeEach(() => {
    clearPlaybookCache();
    delete process.env['BABEL_CHAT_PLAYBOOKS'];
  });

  afterEach(() => {
    clearPlaybookCache();
    if (prev === undefined) delete process.env['BABEL_CHAT_PLAYBOOKS'];
    else process.env['BABEL_CHAT_PLAYBOOKS'] = prev;
  });

  it('loads shipped playbooks from disk', () => {
    const pbs = loadPlaybooks();
    assert.ok(pbs.length >= 2);
    assert.ok(pbs.some((p) => p.id === 'single-file'));
    assert.ok(pbs.some((p) => p.id === 'multi-file'));
  });

  it('P2.2: single-file playbook prefers narrow localization + test-file headers', () => {
    const pbs = loadPlaybooks();
    const single = pbs.find((p) => p.id === 'single-file');
    assert.ok(single, 'single-file playbook present');
    const explore = single!.phaseGuidance?.explore ?? '';
    assert.match(explore, /FAIL_TO_PASS|test file/i);
    assert.match(explore, /LOCALIZATION LADDER|tight/i);
    assert.match(explore, /grep/i);
    const verify = single!.phaseGuidance?.verify ?? '';
    assert.match(verify, /_verify/i);
  });

  it('P2.2: multi-file playbook starts from tests not broad walks', () => {
    const pbs = loadPlaybooks();
    const multi = pbs.find((p) => p.id === 'multi-file');
    assert.ok(multi, 'multi-file playbook present');
    const explore = multi!.phaseGuidance?.explore ?? '';
    assert.match(explore, /FAIL_TO_PASS|failing test/i);
    assert.match(explore, /targeted reads|tight/i);
  });

  it('selectPlaybookBySkills prefers multi_file', () => {
    const pb = selectPlaybookBySkills(['multi_file', 'multi_hunk']);
    assert.equal(pb?.id, 'multi-file');
  });

  it('inferChatTaskSkills tags multi-file tasks', () => {
    const skills = inferChatTaskSkills('Refactor the auth flow across multiple files');
    assert.ok(skills.includes('multi_file'));
  });

  it('inferChatTaskSkills does not tag generic single-file fixes (no SWE python inject)', () => {
    const skills = inferChatTaskSkills('Fix the bug in auth.ts');
    assert.equal(skills.includes('single_file'), false);
    assert.equal(skills.includes('multi_file'), false);
  });

  it('selectPlaybookForChatTask returns multi-file for multi-file general_swe task', () => {
    // Task classified as general_swe via multi-file + root cause signals
    const pb = selectPlaybookForChatTask(
      'Please fix this multi-file root cause bug in the payment module across the repo',
    );
    assert.equal(pb?.id, 'multi-file');
  });

  it('selectPlaybookForChatTask skips single-file SWE playbook for generic fixes', () => {
    const pb = selectPlaybookForChatTask('Fix the bug in auth.ts');
    assert.equal(pb, undefined);
  });

  // ── U1.4: Tightened playbook selection — only general_swe gets playbooks ──

  it('U1.4: skips playbook for default-class task even with multi-file keywords', () => {
    // "across files" triggers multi_file in inferChatTaskSkills, but without
    // general_swe signals (root cause, regression, etc.) the class is default.
    const pb = selectPlaybookForChatTask(
      'Fix the type error across several files in the project',
    );
    assert.equal(pb, undefined, 'default-class tasks should not get playbook inject');
  });

  it('U1.4: skips playbook for quick_fix task even with multi-file keywords', () => {
    const pb = selectPlaybookForChatTask(
      'Just fix the typo across multiple files',
    );
    assert.equal(pb, undefined, 'quick_fix tasks should not get playbook inject');
  });

  it('U1.4: returns playbook for general_swe task with multi-file signals', () => {
    // "root cause" + "multi-file" signals → general_swe
    const pb = selectPlaybookForChatTask(
      'Find the root cause of the multi-file regression in the auth module',
    );
    assert.equal(pb?.id, 'multi-file', 'general_swe tasks should get playbook inject');
  });

  it('U1.4: BABEL_CHAT_SWE_PROFILE=1 forces playbook for multi-file task', () => {
    process.env['BABEL_CHAT_SWE_PROFILE'] = '1';
    try {
      const pb = selectPlaybookForChatTask(
        'Fix the bug across several files',
      );
      assert.equal(pb?.id, 'multi-file', 'SWE_PROFILE should force general_swe → playbook');
    } finally {
      delete process.env['BABEL_CHAT_SWE_PROFILE'];
    }
  });

  it('U1.4: BABEL_CHAT_TASK_CLASS=general_swe forces playbook', () => {
    process.env['BABEL_CHAT_TASK_CLASS'] = 'general_swe';
    try {
      const pb = selectPlaybookForChatTask(
        'Fix the bug across several files',
      );
      assert.equal(pb?.id, 'multi-file', 'explicit general_swe class should get playbook');
    } finally {
      delete process.env['BABEL_CHAT_TASK_CLASS'];
    }
  });

  it('U1.4: BABEL_CHAT_TASK_CLASS=default skips playbook even with multi-file keywords', () => {
    process.env['BABEL_CHAT_TASK_CLASS'] = 'default';
    try {
      const pb = selectPlaybookForChatTask(
        'Fix the multi-file bug across the entire codebase with root cause analysis',
      );
      assert.equal(pb, undefined, 'explicit default class should skip playbook');
    } finally {
      delete process.env['BABEL_CHAT_TASK_CLASS'];
    }
  });

  it('selectPlaybookForChatTask disabled via env', () => {
    process.env['BABEL_CHAT_PLAYBOOKS'] = '0';
    const pb = selectPlaybookForChatTask(
      'Please fix this multi-file root cause regression bug',
    );
    assert.equal(pb, undefined);
  });

  it('resolvePlaybooksDir finds JSON even when module dir is empty (src fallback)', async () => {
    const { resolvePlaybooksDir } = await import('./playbookService.js');
    const dir = resolvePlaybooksDir();
    assert.ok(dir.length > 0);
    const pbs = loadPlaybooks(dir);
    assert.ok(pbs.length >= 2);
  });

  it('buildPlaybookPrompt includes guidance and plan warning', () => {
    const pb: PlaybookDefinition = {
      id: 't',
      description: 't',
      select: { skills: ['x'] },
      requireTodoPlan: true,
      planFirstWarning: 'PLAN FIRST',
      phaseGuidance: { explore: 'E', diagnose: 'D', fix: 'F', verify: 'V' },
    };
    const text = buildPlaybookPrompt(pb);
    assert.ok(text.includes('## Task Guidance'));
    assert.ok(text.includes('EXPLORE: E'));
    assert.ok(text.includes('PLAN FIRST'));
  });

  // ── D2: thrash alignment (RC9) ───────────────────────────────────

  it('D2: single-file fix mandates str_replace before pytest (mutate before verify)', () => {
    const pbs = loadPlaybooks();
    const single = pbs.find((p) => p.id === 'single-file');
    assert.ok(single, 'single-file playbook present');
    const fix = single!.phaseGuidance?.fix ?? '';
    assert.match(fix, /MUTATE BEFORE VERIFY/i);
    assert.match(fix, /Do NOT run pytest|Do NOT run.*test suite.*before.*str_replace/i);
    assert.match(fix, /str_replace.*then|mutate first/i);
  });

  it('D2: single-file verify forbids install thrash on env red (BLOCKED / patch-ready)', () => {
    const pbs = loadPlaybooks();
    const single = pbs.find((p) => p.id === 'single-file');
    assert.ok(single, 'single-file playbook present');
    const verify = single!.phaseGuidance?.verify ?? '';
    assert.match(verify, /BLOCKED|patch-ready/i);
    assert.match(verify, /do NOT install|do NOT.*shell-thrash/i);
    assert.match(verify, /Do NOT run the full suite/i);
  });

  it('D2: multi-file fix mandates mutate before full suite', () => {
    const pbs = loadPlaybooks();
    const multi = pbs.find((p) => p.id === 'multi-file');
    assert.ok(multi, 'multi-file playbook present');
    const fix = multi!.phaseGuidance?.fix ?? '';
    assert.match(fix, /MUTATE BEFORE VERIFY/i);
    assert.match(fix, /Do NOT run the full test suite.*before.*str_replace/i);
  });

  it('D2: multi-file verify forbids install thrash on env red (BLOCKED / patch-ready)', () => {
    const pbs = loadPlaybooks();
    const multi = pbs.find((p) => p.id === 'multi-file');
    assert.ok(multi, 'multi-file playbook present');
    const verify = multi!.phaseGuidance?.verify ?? '';
    assert.match(verify, /BLOCKED|patch-ready/i);
    assert.match(verify, /do NOT install|do NOT.*shell-thrash/i);
    assert.match(verify, /Do NOT run the full suite|After all edits.*run the related suite/i);
  });
});

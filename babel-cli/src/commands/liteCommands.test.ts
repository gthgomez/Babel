import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { BABEL_ROOT } from '../cli/constants.js';
import { applyUserFocusedHelpTiers, buildApprovalProfilePayload, resolveBenchmarkAnalyzeRun } from './coreCommands.js';
import {
  READ_ONLY_LITE_TOOLS,
  classifyDoTask,
  registerWorkflowCommands,
  resolveLiteAllowedTools,
  resolveLitePipelineMode,
} from './workflowCommands.js';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerWorkflowCommands(program);
  return program;
}

describe('Babel Lite command registration', () => {
  it('registers lite ask, plan, do, fix, and visible proposal-only patch commands', () => {
    const program = makeProgram();
    const lite = program.commands.find(command => command.name() === 'lite');
    assert.ok(lite);
    assert.equal(lite.alias(), 'l');
    assert.deepEqual(
      lite.commands.map(command => command.name()).sort(),
      ['ask', 'continue', 'diff', 'do', 'fix', 'patch', 'plan', 'propose', 'resume', 'review', 'undo'],
    );
    const fix = lite.commands.find(command => command.name() === 'fix');
    assert.ok(fix);
    assert.deepEqual(fix.aliases(), []);
    const patch = lite.commands.find(command => command.name() === 'patch');
    assert.ok(patch);
    assert.notEqual((patch as unknown as { _hidden?: boolean })._hidden, true);
    assert.match(patch.description(), /proposal-only diff/i);
  });

  it('teaches bl examples before the full Babel path', () => {
    const program = makeProgram();
    const lite = program.commands.find(command => command.name() === 'lite');
    assert.ok(lite);
    let help = '';
    lite.configureOutput({
      writeOut: (value) => {
        help += value;
      },
      writeErr: (value) => {
        help += value;
      },
    });

    assert.throws(() => lite.parse(['node', 'lite', '--help']));
    assert.match(help, /bl ask "Why is this failing\?"/);
    assert.match(help, /bl fix "Fix failing tests"/);
    assert.match(help, /Use babel run for advanced audit/);
  });

  it('tells fresh clones the repo-root build command when dist output is missing', () => {
    const liteBin = readFileSync(join(BABEL_ROOT, 'babel-cli', 'bin', 'babel-lite.js'), 'utf-8');
    const fullBin = readFileSync(join(BABEL_ROOT, 'babel-cli', 'bin', 'babel.js'), 'utf-8');

    assert.equal(liteBin.includes('npm --prefix .\\\\babel-cli run build'), true);
    assert.equal(fullBin.includes('npm --prefix .\\\\babel-cli run build'), true);
  });

  it('registers top-level ask, plan, fix, do, and full user verbs', () => {
    const program = makeProgram();
    for (const name of ['ask', 'plan', 'propose', 'fix', 'review', 'undo', 'do', 'full']) {
      assert.ok(program.commands.find(command => command.name() === name), `${name} command missing`);
    }
  });

  it('exposes full-lane execution options on the new full command', () => {
    const program = makeProgram();
    const topLevelFull = program.commands.find(command => command.name() === 'full');
    assert.ok(topLevelFull);
    assert.ok(topLevelFull.options.some(option => option.long === '--agents'));
    assert.ok(topLevelFull.options.some(option => option.long === '--project-root'));
    assert.ok(topLevelFull.options.some(option => option.long === '--json'));
  });

  it('exposes visible automatic routing controls on the do lane', () => {
    const program = makeProgram();
    const topLevelDo = program.commands.find(command => command.name() === 'do');
    const lite = program.commands.find(command => command.name() === 'lite');
    const liteDo = lite?.commands.find(command => command.name() === 'do');

    assert.ok(topLevelDo);
    assert.ok(liteDo);
    assert.ok(topLevelDo.options.some(option => option.long === '--lite-only'));
    assert.ok(topLevelDo.options.some(option => option.long === '--agents'));
    assert.ok(liteDo.options.some(option => option.long === '--lite-only'));
    assert.ok(liteDo.options.some(option => option.long === '--agents'));
  });

  it('keeps default help focused while exposing advanced tiers', () => {
    const program = makeProgram();
    applyUserFocusedHelpTiers(program);

    let help = '';
    program.configureOutput({
      writeOut: (value) => {
        help += value;
      },
      writeErr: (value) => {
        help += value;
      },
    });

    assert.throws(() => program.parse(['node', 'babel', '--help']));
    assert.match(help, /ask .*without editing/i);
    assert.match(help, /fix .*focused safe edit/i);
    assert.match(help, /advanced .*advanced Babel command groups/i);
    assert.doesNotMatch(help, /\bmcp\s+Manage MCP/);
    assert.doesNotMatch(help, /\bdirect\b|\bverified\b|\bmanual\b|\bautonomous\b|\bparallel_swarm\b/);
  });

  it('routes Lite verbs through the simplest mode that fits the user intent', () => {
    assert.equal(resolveLitePipelineMode('ask'), 'direct');
    assert.equal(resolveLitePipelineMode('plan'), 'direct');
    assert.equal(resolveLitePipelineMode('fix'), 'verified');
    assert.equal(resolveLitePipelineMode('patch'), 'direct');
    assert.equal(resolveLitePipelineMode('propose'), 'direct');
    assert.equal(resolveLitePipelineMode('do'), 'verified');
    assert.deepEqual(resolveLiteAllowedTools('ask'), READ_ONLY_LITE_TOOLS);
    assert.deepEqual(resolveLiteAllowedTools('plan'), READ_ONLY_LITE_TOOLS);
    assert.deepEqual(resolveLiteAllowedTools('patch'), READ_ONLY_LITE_TOOLS);
    assert.deepEqual(resolveLiteAllowedTools('fix'), []);
    assert.deepEqual(resolveLiteAllowedTools('do'), []);
  });

  it('classifies do requests into ask, plan, patch, or fix lanes', () => {
    assert.equal(classifyDoTask('Explain this repo without editing.'), 'ask');
    assert.equal(classifyDoTask('Summarize this module.'), 'ask');
    assert.equal(classifyDoTask('What is the active Lite entrypoint?'), 'ask');
    assert.equal(classifyDoTask('How does the checkpoint flow work?'), 'ask');
    assert.equal(classifyDoTask('Plan a safe migration path.'), 'plan');
    assert.equal(classifyDoTask('Compare these implementation approaches.'), 'plan');
    assert.equal(classifyDoTask('Propose a patch for the Lite help text.'), 'patch');
    assert.equal(classifyDoTask('Generate a diff proposal for the Lite help text.'), 'patch');
    assert.equal(classifyDoTask('Fix the failing test. Only edit src/math.js. Run npm test before completing.'), 'fix');
    assert.equal(classifyDoTask('Update the Lite help text.'), 'fix');
    assert.equal(classifyDoTask('Implement the Lite help text update.'), 'fix');
    assert.equal(classifyDoTask('Look at the Lite help text.'), 'plan');
  });

  it('describes permissions in user terms before policy labels', () => {
    const payload = buildApprovalProfilePayload({
      profile: 'auto-edit',
      runtimeMode: 'act',
      dryRun: {
        persisted: false,
        sessionOverride: null,
        effective: false,
        runtimeFlagsPath: 'config/runtime-flags.json',
        source: 'persisted',
      },
      profilePath: 'config/approval-profile.json',
    });

    assert.match(String(payload['action']), /edit files and run local checks/i);
    assert.deepEqual(payload['scope'], [
      'edit in-scope project files',
      'run local verifiers such as npm test',
      'write recovery evidence for failures',
    ]);
    assert.match(String(payload['approval']), /Trusted workspace work should not ask redundant approvals/i);
    assert.equal(payload['profile'], 'auto-edit');
  });

  it('reports missing Terminal-Bench latest roots as actionable setup blockers', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-missing-benchmark-root-'));
    assert.throws(
      () => resolveBenchmarkAnalyzeRun('latest', { benchmarksRoot: root, suite: 'pilot10' }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as { name?: string }).name, 'ActionableCommandError');
        const payload = (error as { payload?: Record<string, unknown> }).payload;
        assert.equal(payload?.['status'], 'blocked');
        assert.equal(payload?.['reason'], 'terminal_bench_result_root_missing');
        assert.match(String(payload?.['expected_result_root']), /terminal-bench-2/);
        assert.match(JSON.stringify(payload?.['commands']), /benchmark loop/);
        return true;
      },
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { BABEL_ROOT } from '../cli/constants.js';
import {
  applyUserFocusedHelpTiers,
  buildApprovalProfilePayload,
  resolveBenchmarkAnalyzeRun,
} from './coreCommands.js';
import { classifyDoTask, registerWorkflowCommands } from './workflowCommands.js';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerWorkflowCommands(program);
  return program;
}

describe('Babel CLI command registration', () => {
  it('registers plan and deep commands, and verifies removed Lite commands are not registered', () => {
    const program = makeProgram();
    const plan = program.commands.find((command) => command.name() === 'plan');
    const deep = program.commands.find((command) => command.name() === 'deep');
    assert.ok(plan);
    assert.ok(deep);
    assert.equal(
      program.commands.some((command) => command.name() === 'daily'),
      false,
    );
    assert.equal(
      program.commands.some((command) => command.name() === 'undo'),
      true,
    );
    assert.equal(
      program.commands.some((command) => command.name() === 'review'),
      false,
    );
    assert.equal(
      program.commands.some((command) => command.name() === 'lite'),
      false,
    );
    assert.equal(deep.aliases().includes('full'), false);
  });

  it('tells fresh clones the repo-root build command when dist output is missing', () => {
    const liteBin = readFileSync(join(BABEL_ROOT, 'babel-cli', 'bin', 'babel-lite.js'), 'utf-8');
    const fullBin = readFileSync(join(BABEL_ROOT, 'babel-cli', 'bin', 'babel.js'), 'utf-8');

    assert.equal(liteBin.includes('was removed'), true);
    assert.equal(fullBin.includes('npm --prefix .\\\\babel-cli run build'), true);
  });

  it('keeps deep and plan user-facing without execution-profile', () => {
    const program = makeProgram();
    const topLevelDeep = program.commands.find((command) => command.name() === 'deep');
    const topLevelPlan = program.commands.find((command) => command.name() === 'plan');
    assert.ok(topLevelDeep);
    assert.ok(topLevelPlan);
    assert.ok(topLevelDeep.options.some((option) => option.long === '--project-root'));
    assert.ok(topLevelDeep.options.some((option) => option.long === '--json'));
    assert.equal(
      topLevelDeep.options.some((option) => option.long === '--execution-profile'),
      false,
    );
    assert.equal(
      topLevelPlan.options.some((option) => option.long === '--execution-profile'),
      false,
    );
  });

  it('registers undo with project scoping options', () => {
    const program = makeProgram();
    const undo = program.commands.find((command) => command.name() === 'undo');
    assert.ok(undo);
    assert.ok(undo.options.some((option) => option.long === '--project'));
    assert.ok(undo.options.some((option) => option.long === '--project-root'));
    assert.ok(undo.options.some((option) => option.long === '--json'));
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
    assert.match(help, /plan .*Prepare a plan/i);
    assert.match(help, /deep .*governed apply-and-verify path/i);
    assert.match(help, /advanced .*advanced Babel command groups/i);
    assert.doesNotMatch(help, /\blite\b/i);
    assert.doesNotMatch(help, /\bask\b.*without editing/i);
    assert.doesNotMatch(help, /\bfix\b.*focused safe edit/i);
    assert.doesNotMatch(help, /\bmcp\s+Manage MCP/);
    assert.doesNotMatch(
      help,
      /\bdirect\b|\bverified\b|\bmanual\b|\bautonomous\b|\bparallel_swarm\b/,
    );
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
    assert.equal(
      classifyDoTask(
        'Fix the failing test. Only edit src/math.js. Run npm test before completing.',
      ),
      'fix',
    );
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
    assert.match(
      String(payload['approval']),
      /Trusted workspace work should not ask redundant approvals/i,
    );
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

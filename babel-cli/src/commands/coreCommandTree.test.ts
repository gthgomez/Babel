import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Command } from 'commander';
import { registerCoreCommands } from './coreCommands.js';

// Captured before the ownership extraction. This binds names, ordering, aliases,
// descriptions, arguments and option flags without machine-specific defaults.
// Consumer packaging deliberately adds --contributor to setup and doctor.
// Generic doctor project examples intentionally update its option description.
type CommandContract = {
  name: string; aliases: string[]; description: string;
  args: Array<{ name: string; required: boolean; variadic: boolean; description: string }>;
  options: Array<{ flags: string; description: string; mandatory: boolean }>;
  children: CommandContract[];
};

function commandTree(command: Command): CommandContract {
  return {
    name: command.name(), aliases: command.aliases(), description: command.description(),
    args: command.registeredArguments.map(arg => ({ name: arg.name(), required: arg.required, variadic: arg.variadic, description: arg.description })),
    options: command.options.map(option => ({ flags: option.flags, description: option.description, mandatory: option.mandatory })),
    children: command.commands.map(commandTree),
  };
}

function withoutIntentionalCommandExtensions(contract: CommandContract): CommandContract {
  return {
    ...contract,
    children: contract.children
      .filter(child => child.name !== 'research')
      .map(child => child.name === 'evidence'
        ? { ...child, children: child.children.filter(sub => sub.name !== 'replay') }
        : child.name === 'runs'
          ? { ...child, children: child.children.filter(sub => sub.name !== 'review') }
          : child),
  };
}

test('core registration preserves the complete existing command contract', () => {
  const program = new Command();
  registerCoreCommands(program);
  const contract = commandTree(program);
  const research = contract.children.filter(child => child.name === 'research');
  assert.equal(research.length, 1);
  assert.equal(contract.children.at(-1)?.name, 'research', 'the intentional new group is appended after the existing contract');
  const evidence = contract.children.find(child => child.name === 'evidence');
  assert.ok(evidence);
  const replay = evidence.children.filter(child => child.name === 'replay');
  assert.equal(replay.length, 1);
  const runs = contract.children.find(child => child.name === 'runs');
  assert.ok(runs);
  assert.deepEqual(runs.children.map(child => child.name), ['inventory', 'review', 'coverage', 'query', 'show', 'failures', 'verify']);
  const runReview = runs.children.filter(child => child.name === 'review');
  assert.equal(runReview.length, 1);
  assert.deepEqual(runReview[0], {
    name: 'review', aliases: [], description: 'Review a local evidence window without replay, execution or network calls',
    args: [],
    options: [
      { flags: '--catalog <path>', description: 'Existing derived SQLite catalog', mandatory: false },
      { flags: '--last-hours <hours>', description: 'Window size, default 24', mandatory: false },
      { flags: '--until <timestamp>', description: 'Window end (ISO timestamp; default now)', mandatory: false },
      { flags: '--json', description: 'Emit minimized structured review', mandatory: false },
    ],
    children: [],
  });
  assert.equal(program.commands.find(child => child.name() === 'runs')?.commands.find(child => child.name() === 'review')?.options.find(option => option.flags === '--last-hours <hours>')?.defaultValue, '24');
  const legacy = withoutIntentionalCommandExtensions(contract);
  const digest = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  assert.equal(digest, '5a7149653f90ac455439e49e107a93853b16c738aa04bf07674c23ceb0fa6541');
  assert.deepEqual(replay[0], {
    name: 'replay', aliases: [], description: 'Render the replay transcript of persisted action/observation evidence for a conversation',
    args: [{ name: 'conversation-id', required: true, variadic: false, description: '' }],
    options: [
      { flags: '--run <path>', description: 'Run directory holding episode-events.jsonl (default: chat session dir for the id)', mandatory: false },
      { flags: '--json', description: 'Emit structured JSON only', mandatory: false },
    ],
    children: [],
  });
  const researchNode = research[0]!
  assert.deepEqual(researchNode.children.map((child) => child.name), ['v2', 'hunt', 'inspect']);
  const v2 = researchNode.children[0]!
  assert.equal(v2.name, 'v2');
  assert.deepEqual(
    v2.children.map((child) => child.name),
    [
      'dry-run-plan',
      'live-status',
      'model-route',
      'run',
      'inspect',
      'report',
      'cancel',
      'resume',
      'cancel-resume-once',
      'live-plan',
    ],
  );
  const hunt = researchNode.children.find((child) => child.name === 'hunt');
  const inspectLegacy = researchNode.children.find((child) => child.name === 'inspect');
  assert.deepEqual(hunt, {
    name: 'hunt', aliases: [], description: 'hunt OSS for implementations analogous to the problem (discovery through shortlist)',
    args: [{ name: 'problem', required: true, variadic: false, description: '' }],
    options: [
      { flags: '--project <path>', description: 'target project root', mandatory: true },
      { flags: '--budget <preset>', description: 'named budget preset: low | normal | deep', mandatory: false },
      { flags: '--json', description: 'emit machine-readable output', mandatory: false },
    ], children: [],
  });
  assert.deepEqual(inspectLegacy, {
    name: 'inspect', aliases: [], description: 'explain a persisted research mission run (mission, candidates, scores, budget)',
    args: [{ name: 'mission-id', required: true, variadic: false, description: '' }],
    options: [
      { flags: '--runs-root <path>', description: 'runs root to search', mandatory: false },
      { flags: '--json', description: 'emit machine-readable output', mandatory: false },
    ], children: [],
  });
});

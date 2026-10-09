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
  assert.deepEqual(research[0], {
    name: 'research', aliases: [], description: 'Repo Hunt research missions (discover, inspect, and learn from OSS evidence)',
    args: [], options: [], children: [
      {
        name: 'hunt', aliases: [], description: 'hunt OSS for implementations analogous to the problem (discovery through shortlist)',
        args: [{ name: 'problem', required: true, variadic: false, description: '' }],
        options: [
          { flags: '--project <path>', description: 'target project root', mandatory: true },
          { flags: '--budget <preset>', description: 'named budget preset: low | normal | deep', mandatory: false },
          { flags: '--json', description: 'emit machine-readable output', mandatory: false },
        ], children: [],
      },
      {
        name: 'inspect', aliases: [], description: 'explain a persisted research mission run (mission, candidates, scores, budget)',
        args: [{ name: 'mission-id', required: true, variadic: false, description: '' }],
        options: [
          { flags: '--runs-root <path>', description: 'runs root to search', mandatory: false },
          { flags: '--json', description: 'emit machine-readable output', mandatory: false },
        ], children: [],
      },
    ],
  });
});

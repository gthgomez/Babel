import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Command } from 'commander';
import { registerCoreCommands } from './coreCommands.js';

// Captured before the ownership extraction. This binds names, ordering, aliases,
// descriptions, arguments and option flags without machine-specific defaults.
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

test('core registration preserves the complete existing command contract', () => {
  const program = new Command();
  registerCoreCommands(program);
  const contract = commandTree(program);
  const research = contract.children.filter(child => child.name === 'research');
  assert.equal(research.length, 1);
  assert.equal(contract.children.at(-1)?.name, 'research', 'the intentional new group is appended after the existing contract');
  const legacy = { ...contract, children: contract.children.filter(child => child.name !== 'research') };
  const digest = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  assert.equal(digest, 'b5c712d6f8390021db45a1651509cfefcaa92460101df75694a6ed829d831df8');
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

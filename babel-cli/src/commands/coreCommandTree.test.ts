import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Command } from 'commander';
import { registerCoreCommands } from './coreCommands.js';

// Captured before the ownership extraction. This binds names, ordering, aliases,
// descriptions, arguments and option flags without machine-specific defaults.
function commandTree(command: Command): unknown {
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
  const digest = createHash('sha256').update(JSON.stringify(commandTree(program))).digest('hex');
  assert.equal(digest, 'b5c712d6f8390021db45a1651509cfefcaa92460101df75694a6ed829d831df8');
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Command } from 'commander';
import { registerCoreCommands } from './coreCommands.js';

// Captured before the ownership extraction. This binds names, ordering, aliases,
// descriptions, arguments and option flags without machine-specific defaults.
// Consumer packaging deliberately adds --contributor to setup and doctor.
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
  assert.equal(digest, '055c2fe63f88d850d8f281f11bed324e1181eb8a8321f990aa5eded79f2d503b');
});

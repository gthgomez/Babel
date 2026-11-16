import { Command } from 'commander';
import { registerCoreInvocation } from '../commands/coreInvocation.js';
import { registerInteractiveCommand } from '../commands/interactiveCommand.js';
import { bootstrapCliEnvironment, withCliInvocation } from './cliBootstrap.js';

/** Bare launches need the shared interactive command, not every workflow. */
export async function startPlainInteractiveCli(argv: string[]): Promise<void> {
  bootstrapCliEnvironment(argv);
  const program = new Command();
  registerCoreInvocation(program);
  registerInteractiveCommand(program);
  const rewritten = argv.length === 2 ? [...argv, 'interactive'] : argv;
  await withCliInvocation(() => program.parseAsync(rewritten));
}

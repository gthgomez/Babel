import type { Command } from 'commander';
import { startInteractiveSession } from '../interactive/BabelRepl.js';

/** The same interactive command is used by both executable startup paths. */
export function registerInteractiveCommand(program: Command): void {
  program
    .command('interactive')
    .alias('app')
    .description('Default: enter persistent interactive Babel session (REPL)')
    .option('-p, --project <name>', 'Default project for this session')
    .option('--mode <mode>', 'Workflow for this session: work or plan')
    .option('--resume [sessionId]', 'Resume a prior session (latest if omitted)')
    .option('--resume-picker', 'Show the session picker at startup (off by default)')
    .addHelpText('after', `
Interactive slash command map:
  /checkpoint, /restore, /session
  /mcp, /plugins, /plugin, /agents
`)
    .action(async (options: {
      project?: string;
      mode?: string;
      resume?: string | boolean;
      resumePicker?: boolean;
    }) => {
      try {
        if (options.resumePicker) process.env['BABEL_RESUME_PICKER'] = '1';
        if (options.resume !== undefined) {
          process.env['BABEL_RESUME_SESSION'] = options.resume === true || options.resume === '' ? 'latest' : String(options.resume);
        }
        await startInteractiveSession({
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.mode !== undefined ? { mode: (options.mode === 'work' ? 'chat' : options.mode) as never, modeExplicit: true } : {}),
        });
      } catch (err: unknown) {
        console.error(`Interactive session error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

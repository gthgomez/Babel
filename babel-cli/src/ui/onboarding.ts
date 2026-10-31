/**
 * First-run onboarding experience for Babel.
 *
 * Shows a welcome banner with ASCII art logo, a compact quick-reference
 * of the most useful commands, and key getting-started tips.
 *
 * @module onboarding
 */

import { OutputBuffer } from './outputBuffer.js';
import { primary, accentBright, muted, dim, bold, success } from './theme.js';
import { readUserSettings } from '../config/userSettings.js';

/**
 * Returns true until the private user profile records completed setup.
 */
export function isFirstRun(): boolean {
  return readUserSettings().setup?.completed !== true;
}

/**
 * Top commands to show in the quick-reference section of onboarding.
 * Keep this list short and focused on what a new user needs first.
 */
const QUICK_COMMANDS: Array<[string, string]> = [
  ['/setup', 'Connect your provider, model and budget'],
  ['/provider status', 'Show connection and credential readiness'],
  ['/help', 'Show all commands and groups'],
  ['/model use <id>', 'Choose an exact model on this connection'],
  ['/theme', 'Pick a color theme'],
  ['/mode work|plan', 'Work or produce a read-only plan'],
  ['/status', 'Session stats and costs'],
  ['/clear', 'Clear the terminal display'],
  ['/scrollback', 'Browse conversation history'],
  ['Ctrl+P', 'Command palette (search all commands)'],
  ['@filename', 'Search files with fuzzy matching'],
  ['Ctrl+R', 'Search command history'],
];

/**
 * Write the onboarding welcome banner to stdout.
 *
 * Includes a simple ASCII-art Babel logo, a compact quick-reference
 * table, and key getting-started tips. Designed to be glanceable and
 * non-intimidating for first-time users.
 */
export function showOnboarding(): void {
  const width = Math.min(process.stdout.columns ?? 80, 80);

  const logo = width < 48 ? accentBright('  BABEL') : [
    accentBright('  ██████╗  █████╗ ██████╗ ███████╗██╗     '),
    accentBright('  ██╔══██╗██╔══██╗██╔══██╗██╔════╝██║     '),
    accentBright('  ██████╔╝███████║██████╔╝█████╗  ██║     '),
    accentBright('  ██╔══██╗██╔══██║██╔══██╗██╔══╝  ██║     '),
    accentBright('  ██████╔╝██║  ██║██████╔╝███████╗███████╗'),
    accentBright('  ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝'),
  ].join('\n');

  // Quick-reference command table
  const cmdWidth = Math.max(...QUICK_COMMANDS.map(([cmd]) => cmd.length));
  const cmdLines = QUICK_COMMANDS.map(
    ([cmd, desc]) =>
      `  ${bold(cmd.padEnd(cmdWidth))}  ${muted(desc)}`,
  );

  const output = [
    '',
    logo,
    '',
    `  ${primary('Welcome to Babel')} ${dim('— your conversational coding agent.')}`,
    '',
    `  ${dim('Quick reference:')}`,
    ...cmdLines,
    '',
    `  ${success('✓')} ${dim('Type a task to get started.')} Try: ${muted('"summarize this repo"')}`,
    `  ${success('✓')} ${dim('Type')} ${bold('/help')} ${dim('for the full command list.')}`,
    `  ${success('✓')} ${dim('Use')} ${bold('@')} ${dim('to search files by name.')}`,
    '',
    dim('─'.repeat(width)),
    '',
  ].join('\n');

  OutputBuffer.getInstance().write(output);
}

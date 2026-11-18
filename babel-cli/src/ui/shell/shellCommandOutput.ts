/**
 * Which slash commands the hosted shell may capture and render in its
 * conversation pane.
 *
 * Only text-reporting commands are listed. Commands that own the terminal
 * (pagers, pickers, prompts, keybinding wizards, and apply/execute flows that
 * stream a live turn) must keep writing straight to the terminal.
 */
const PRINT_ONLY_COMMANDS = new Set([
  'status',
  'help',
  'h',
  'header',
  'history',
  'cost',
  'stats',
  'mode',
  'permissions',
  'settings',
  'provider',
  'model',
  'm',
  'tools',
  'plugins',
  'mcp',
  'memory',
  'policy',
  'runs',
  'session',
  'checkpoint',
  'why-stopped',
  'whystopped',
  'why',
  'doctor',
]);

/**
 * Whether a slash command's stdout should be captured for the shell.
 *
 * @param command - Lower-case command name without the leading slash.
 * @returns True for print-only commands.
 */
export function capturesShellCommandOutput(command: string): boolean {
  return PRINT_ONLY_COMMANDS.has(command);
}

/**
 * Which slash commands the hosted shell may capture and render in its
 * conversation pane.
 *
 * Only text-reporting commands are listed. Commands that own the terminal
 * (pagers, pickers, prompts, keybinding wizards, and apply/execute flows that
 * stream a live turn) must keep writing straight to the terminal.
 *
 * `pwd`, `model`, `m` and `provider` use direct shell presentation; bare
 * provider/model forms may also open an exclusive terminal picker.
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
  'chain',
  'agents',
  'target',
  'evidence',
  'thinking',
  'think',
]);

/**
 * Publish captured command output and repaint immediately.
 *
 * The capture window holds repaints so the frame cannot overwrite command
 * output mid-command. `invalidate` is a no-op while that hold is active, so the
 * hold must be released first — otherwise nothing paints until the next
 * keypress (UX-11 follow-up).
 *
 * @param runtime - Hosted conversation binding, when the shell owns one.
 * @param host - Hosted shell, when mounted.
 * @param text - Captured stdout.
 */
export function publishShellCommandOutput(
  runtime: { appendNotice?(text: string): void } | undefined,
  host: { releaseRepaintHold?(): boolean; invalidate?(reason: string): void } | undefined,
  text: string,
): void {
  runtime?.appendNotice?.(text);
  host?.releaseRepaintHold?.();
  host?.invalidate?.('command-output');
}

/**
 * Whether a slash command's stdout should be captured for the shell.
 *
 * @param command - Lower-case command name without the leading slash.
 * @returns True for print-only commands.
 */
export function capturesShellCommandOutput(command: string): boolean {
  return PRINT_ONLY_COMMANDS.has(command);
}

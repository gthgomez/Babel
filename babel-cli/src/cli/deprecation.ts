export const DEPRECATED_SURFACE_COMMANDS = new Set(['lite', 'l', 'full', 'bl', 'babel-lite', 'daily']);

export function formatDeprecatedSurfaceMessage(invoked: string): string {
  const normalized = invoked.trim().toLowerCase();
  const hints: Record<string, string> = {
    bl: 'bl was removed. Use: babel "<task>", babel plan "<task>", or babel deep "<task>".',
    'babel-lite':
      'babel-lite was removed. Use: babel "<task>", babel plan "<task>", or babel deep "<task>".',
    lite: 'babel lite was removed. Use: babel "<task>" for daily work.',
    l: 'babel l was removed. Use: babel "<task>" for daily work.',
    full: 'babel full was removed. Use: babel deep for governed execution.',
    daily: 'babel daily was removed — chat mode is now the default. Use: babel "<task>" directly.',
  };
  return (
    hints[normalized] ??
    `The "${invoked}" command was removed. Use: babel "<task>", babel plan, or babel deep.`
  );
}

export function printDeprecatedSurfaceAndExit(invoked: string): never {
  process.stderr.write(`[babel] ${formatDeprecatedSurfaceMessage(invoked)}\n`);
  process.exit(1);
}

export function isDeprecatedSurfaceCommand(command: string): boolean {
  return DEPRECATED_SURFACE_COMMANDS.has(command.trim().toLowerCase());
}

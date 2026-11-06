export const DEPRECATED_SURFACE_COMMANDS = new Set(['lite', 'l', 'full', 'bl', 'babel-lite', 'daily']);

export function formatDeprecatedSurfaceMessage(invoked: string): string {
  const normalized = invoked.trim().toLowerCase();
  const hints: Record<string, string> = {
    bl: 'bl was removed. Use: babel-harness "<task>", babel-harness plan "<task>", or babel-harness deep "<task>".',
    'babel-lite':
      'babel-lite was removed. Use: babel-harness "<task>", babel-harness plan "<task>", or babel-harness deep "<task>".',
    lite: 'babel lite was removed. Use: babel-harness "<task>" for daily work.',
    l: 'babel l was removed. Use: babel-harness "<task>" for daily work.',
    full: 'babel full was removed. Use: babel-harness deep for governed execution.',
    daily: 'babel daily was removed — chat mode is now the default. Use: babel-harness "<task>" directly.',
  };
  return (
    hints[normalized] ??
    `The "${invoked}" command was removed. Use: babel-harness "<task>", babel-harness plan, or babel-harness deep.`
  );
}

export function printDeprecatedSurfaceAndExit(invoked: string): never {
  process.stderr.write(`[babel] ${formatDeprecatedSurfaceMessage(invoked)}\n`);
  process.exit(1);
}

export function isDeprecatedSurfaceCommand(command: string): boolean {
  return DEPRECATED_SURFACE_COMMANDS.has(command.trim().toLowerCase());
}

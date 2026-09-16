/**
 * Parse a command-line string into argv without invoking a shell.
 * Shell operators remain the responsibility of the sandbox validator.
 */

export class CommandArgvParseError extends Error {
  readonly code = 'COMMAND_ARGV_PARSE_ERROR' as const

  constructor(message: string) {
    super(message)
    this.name = 'CommandArgvParseError'
  }
}

/**
 * Parse a non-shell command string while preserving quoted whitespace and
 * empty quoted arguments.
 *
 * @param command - command line to parse
 * @param platform - target platform quoting convention
 * @returns argv with the executable as the first item
 */
export function parseCommandArgv(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args: string[] = []
  let current = ''
  let tokenStarted = false
  let quote: 'single' | 'double' | null = null

  const push = (): void => {
    if (tokenStarted) args.push(current)
    current = ''
    tokenStarted = false
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === 'single') {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === 'double') {
      if (char === '"') {
        quote = null
        continue
      }
      if (char === '\\') {
        const next = command[index + 1]
        const escapesOnPlatform = platform !== 'win32'
          ? next === '"' || next === '\\' || next === '$' || next === '`'
          : next === '"' || next === '\\'
        if (next !== undefined && escapesOnPlatform) {
          current += next
          index++
          continue
        }
      }
      current += char
      continue
    }

    if (/\s/.test(char)) {
      push()
      continue
    }
    if (char === "'") {
      quote = 'single'
      tokenStarted = true
      continue
    }
    if (char === '"') {
      quote = 'double'
      tokenStarted = true
      continue
    }
    if (char === '\\' && platform !== 'win32') {
      const next = command[index + 1]
      if (next !== undefined) {
        current += next
        tokenStarted = true
        index++
        continue
      }
    }
    current += char
    tokenStarted = true
  }

  if (quote !== null) throw new CommandArgvParseError('Unterminated quoted argument')
  push()
  if (args.length === 0) throw new CommandArgvParseError('Command must contain an executable')
  return args
}

/**
 * Quote an argv item for a Windows command interpreter invocation.
 *
 * @param value - argv item to quote
 * @returns command-line-safe Windows argument
 */
export function quoteWindowsCommandArg(value: string): string {
  if (!/[\s"]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

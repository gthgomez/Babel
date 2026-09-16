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
        if (platform === 'win32') {
          // CommandLineToArgvW/CRT-compatible handling: backslashes only
          // acquire escape meaning immediately before a double quote. An
          // even run closes the quoted token; an odd run emits a literal
          // quote. This is required to round-trip quoted paths ending in `\`.
          let slashCount = 0
          while (command[index + slashCount] === '\\') slashCount++
          if (command[index + slashCount] === '"') {
            current += '\\'.repeat(Math.floor(slashCount / 2))
            if (slashCount % 2 === 1) current += '"'
            else quote = null
            index += slashCount
            continue
          }
          current += '\\'.repeat(slashCount)
          index += slashCount - 1
          continue
        }
        const next = command[index + 1]
        const escapesOnPlatform = next === '"' || next === '\\' || next === '$' || next === '`'
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
  if (value.length === 0) return '""'
  if (!/[\s"]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

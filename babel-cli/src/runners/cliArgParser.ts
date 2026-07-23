export interface ParsedCliArgsOptions {
  /** Preserve empty quoted arguments such as `--label ""`. */
  preserveEmpty?: boolean;
}

/**
 * Parse shell-like CLI argument strings into argv tokens.
 *
 * Supports:
 * - Double- and single-quoted tokens
 * - Backslash escapes
 * - Empty quoted tokens (`""`, `''`)
 * - Consecutive whitespace as a separator
 *
 * This parser is intentionally lightweight and only aims to be safe for env-var
 * flag strings, not a full POSIX/Windows shell interpreter.
 */
export function parseCliArgString(value: string, options: ParsedCliArgsOptions = {}): string[] {
  if (!value.trim()) {
    return [];
  }

  const args: string[] = [];
  let token = '';
  let tokenActive = false;
  let inSingle = false;
  let inDouble = false;

  const flush = (): void => {
    if (!tokenActive && options.preserveEmpty !== true) {
      return;
    }
    args.push(token);
    token = '';
    tokenActive = false;
  };

  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);

    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      } else {
        token += char;
        tokenActive = true;
      }
      continue;
    }

    if (inDouble) {
      if (char === '\\' && i + 1 < value.length) {
        const escapedChar = value[i + 1];
        if (escapedChar === undefined) {
          token += '\\';
          tokenActive = true;
          break;
        }
        token += escapedChar ?? '';
        tokenActive = true;
        i += 1;
      } else if (char === '"') {
        inDouble = false;
      } else {
        token += char;
        tokenActive = true;
      }
      continue;
    }

    if (char === "'") {
      inSingle = true;
      tokenActive = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      tokenActive = true;
      continue;
    }
    if (char === '\\' && i + 1 < value.length) {
      const escapedChar = value[i + 1];
      if (escapedChar === undefined) {
        token += '\\';
        tokenActive = true;
        continue;
      }
      token += escapedChar ?? '';
      tokenActive = true;
      i += 1;
      continue;
    }
    if (char === '\\') {
      token += '\\';
      tokenActive = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }

    token += char;
    tokenActive = true;
  }

  if (tokenActive) {
    args.push(token);
  }

  return args;
}

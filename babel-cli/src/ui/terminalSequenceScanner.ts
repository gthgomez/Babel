/**
 * terminalSequenceScanner.ts — Shared internal VT / ANSI sequence scanner.
 *
 * Tokenizes UTF-8 terminal text streams into structured sequence tokens.
 * Shared by sanitize.ts, textLayout.ts, and virtualCellGrid.ts.
 */

export const ESC = '\x1b';
export const BEL = '\x07';

export type TerminalTokenType =
  | 'text'
  | 'csi'
  | 'sgr'
  | 'osc'
  | 'osc8_open'
  | 'osc8_close'
  | 'dcs'
  | 'c0_c1'
  | 'newline'
  | 'carriage_return';

export interface TerminalToken {
  type: TerminalTokenType;
  raw: string;
  /** For SGR tokens: parsed numeric parameters */
  params?: number[];
  /** For OSC 8 tokens: extracted target URI */
  uri?: string;
}

/**
 * Tokenize an input string into a stream of terminal tokens.
 */
export function* scanTerminalTokens(input: string): Generator<TerminalToken> {
  if (!input) return;

  const len = input.length;
  let i = 0;
  let textStart = 0;

  while (i < len) {
    const code = input.charCodeAt(i);

    // Escape sequence (0x1B)
    if (code === 0x1b) {
      if (i > textStart) {
        yield { type: 'text', raw: input.slice(textStart, i) };
      }

      if (i + 1 >= len) {
        // Trailing single escape
        yield { type: 'c0_c1', raw: ESC };
        return;
      }

      const nextChar = input[i + 1];

      // CSI: ESC [
      if (nextChar === '[') {
        let j = i + 2;
        if (j < len && input[j] === '?') j++;
        while (j < len) {
          const c = input.charCodeAt(j);
          if ((c >= 0x40 && c <= 0x7e) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
            const raw = input.slice(i, j + 1);
            const finalChar = input[j];
            if (finalChar === 'm') {
              const paramBody = raw.slice(raw[2] === '?' ? 3 : 2, -1);
              const params =
                paramBody.length === 0
                  ? [0]
                  : paramBody.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10)));
              yield { type: 'sgr', raw, params };
            } else {
              yield { type: 'csi', raw };
            }
            i = j + 1;
            textStart = i;
            break;
          }
          j++;
        }
        if (i < j) {
          // Unclosed CSI at end of chunk
          yield { type: 'csi', raw: input.slice(i) };
          return;
        }
        continue;
      }

      // OSC: ESC ]
      if (nextChar === ']') {
        let j = i + 2;
        let foundEnd = false;
        while (j < len) {
          if (input.charCodeAt(j) === 0x07) {
            foundEnd = true;
            j += 1;
            break;
          }
          if (input.charCodeAt(j) === 0x1b && j + 1 < len && input[j + 1] === '\\') {
            foundEnd = true;
            j += 2;
            break;
          }
          j++;
        }
        const raw = foundEnd ? input.slice(i, j) : input.slice(i);
        i = j;
        textStart = i;

        // Check if OSC 8 hyperlink
        if (raw.startsWith(`${ESC}]8;;`)) {
          const content = raw.endsWith(BEL)
            ? raw.slice(5, -1)
            : raw.endsWith(`${ESC}\\`)
              ? raw.slice(5, -2)
              : raw.slice(5);

          if (content.length === 0) {
            yield { type: 'osc8_close', raw };
          } else {
            yield { type: 'osc8_open', raw, uri: content };
          }
        } else {
          yield { type: 'osc', raw };
        }
        continue;
      }

      // DCS: ESC P ... ESC \
      if (nextChar === 'P') {
        let j = i + 2;
        let foundEnd = false;
        while (j < len) {
          if (input.charCodeAt(j) === 0x1b && j + 1 < len && input[j + 1] === '\\') {
            foundEnd = true;
            j += 2;
            break;
          }
          j++;
        }
        const raw = foundEnd ? input.slice(i, j) : input.slice(i);
        i = j;
        textStart = i;
        yield { type: 'dcs', raw };
        continue;
      }

      // Other 2-byte escape (e.g. ESC 7, ESC 8, ESC =, ESC >)
      yield { type: 'c0_c1', raw: input.slice(i, i + 2) };
      i += 2;
      textStart = i;
      continue;
    }

    // Newline \n (0x0A)
    if (code === 0x0a) {
      if (i > textStart) {
        yield { type: 'text', raw: input.slice(textStart, i) };
      }
      yield { type: 'newline', raw: '\n' };
      i++;
      textStart = i;
      continue;
    }

    // Carriage return \r (0x0D)
    if (code === 0x0d) {
      if (i > textStart) {
        yield { type: 'text', raw: input.slice(textStart, i) };
      }
      yield { type: 'carriage_return', raw: '\r' };
      i++;
      textStart = i;
      continue;
    }

    // C0 control codes (0x00..0x1F, excluding TAB 0x09) and DEL (0x7F)
    if ((code < 32 && code !== 0x09) || code === 7) {
      if (i > textStart) {
        yield { type: 'text', raw: input.slice(textStart, i) };
      }
      yield { type: 'c0_c1', raw: input[i]! };
      i++;
      textStart = i;
      continue;
    }

    // Regular printable character
    i++;
  }

  if (textStart < len) {
    yield { type: 'text', raw: input.slice(textStart) };
  }
}

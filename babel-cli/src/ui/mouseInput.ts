/**
 * XTerm SGR mouse event parser and handler.
 *
 * When the terminal has SGR mouse tracking enabled (CSI ?1003h + CSI ?1006h),
 * mouse events arrive on stdin as escape sequences of the form:
 *
 *   \x1b[<Btn;Y;Xm   — button press
 *   \x1b[<Btn;Y;XM   — button release
 *
 * Scroll wheel events use:
 *   \x1b[<64;Y;XM   — scroll up (Btn=64 in SGR mode)
 *   \x1b[<65;Y;XM   — scroll down (Btn=65 in SGR mode)
 *
 * This module parses these sequences and invokes callbacks for scroll events.
 * Other mouse events (button press/release, motion) are ignored.
 * Non-mouse data passes through unchanged to existing stdin handlers.
 */

const SGR_MOUSE_PREFIX = '\x1b[<';

export interface MouseScrollCallbacks {
  onScrollUp: () => void;
  onScrollDown: () => void;
}

/**
 * Attempt to parse an SGR mouse escape sequence from a data buffer.
 * Returns the parsed event type, or null if the data does not contain
 * a complete mouse sequence.
 */
export function parseSgrMouse(
  data: Buffer | string,
): { type: 'scroll_up' | 'scroll_down' | 'other' } | null {
  const str = typeof data === 'string' ? data : data.toString('utf8');

  if (!str.startsWith(SGR_MOUSE_PREFIX)) return null;

  // Match: \x1b[<Btn;Y;Xm or \x1b[<Btn;Y;XM
  const match = str.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])/);
  if (!match) return null;

  const btn = parseInt(match[1]!, 10);
  const terminator = match[4]!;

  // SGR scroll encoding:
  // Press = m, Release = M
  // scroll up: btn 64
  // scroll down: btn 65
  if (terminator === 'M') {
    // Release events — most terminals send scroll events as releases
    if (btn === 64) return { type: 'scroll_up' };
    if (btn === 65) return { type: 'scroll_down' };
    // Button 0..2 release — ignore
    return { type: 'other' };
  }

  if (terminator === 'm') {
    // Press events — some terminals may encode scroll as press
    if (btn === 64 || btn === 65) return { type: 'other' }; // handled on release
    return { type: 'other' };
  }

  return { type: 'other' };
}

/**
 * Check if a data buffer starts with the SGR mouse prefix.
 * Use as a quick filter before calling parseSgrMouse.
 */
export function isMouseSequence(data: Buffer | string): boolean {
  const str = typeof data === 'string' ? data : data.toString('utf8');
  return str.startsWith(SGR_MOUSE_PREFIX);
}

/**
 * Install a mouse scroll handler on a readable stream (typically process.stdin).
 * Returns a cleanup function that removes the handler.
 *
 * The handler only intercepts mouse scroll events; all other data flows
 * through to any existing listeners.
 */
export function installMouseHandler(
  stream: NodeJS.ReadStream,
  callbacks: MouseScrollCallbacks,
): () => void {
  const onData = (data: Buffer) => {
    // Fast-path: skip if data doesn't look like a mouse sequence
    // (most data is user keyboard input)
    if (data.length < 6 || data[0] !== 0x1b) return;

    const parsed = parseSgrMouse(data);
    if (!parsed) return;

    if (parsed.type === 'scroll_up') {
      callbacks.onScrollUp();
    } else if (parsed.type === 'scroll_down') {
      callbacks.onScrollDown();
    }
  };

  stream.on('data', onData);

  return () => {
    stream.off('data', onData);
  };
}

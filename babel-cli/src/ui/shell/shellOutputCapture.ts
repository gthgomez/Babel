/**
 * Capture stdout produced by a shell-owned slash command.
 *
 * The North Star host paints a fixed full-screen frame and leaves the cursor
 * inside the composer. Slash commands that print text with `console.log`
 * therefore land on top of the frame (UX-11). Capturing their output lets the
 * caller append it to the conversation transcript and repaint once, instead of
 * overwriting the composer.
 *
 * Only stdout is captured. Interactive prompts (provider setup, masked key
 * entry, pagers) still write to stderr/the terminal and keep their own input
 * ownership.
 */

export interface ShellOutputCapture {
  /** Stop capturing and return everything written meanwhile. */
  stop(): string;
}

/**
 * Begin capturing `process.stdout.write`.
 *
 * @returns A handle whose `stop()` restores the previous writer and returns the
 *   captured text. Calling `stop()` more than once is safe.
 */
export function beginShellOutputCapture(): ShellOutputCapture {
  const original = process.stdout.write;
  const chunks: string[] = [];
  let captured = true;

  const patched = ((
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    if (typeof chunk === 'string') chunks.push(chunk);
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk).toString('utf8'));
    else chunks.push(String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') queueMicrotask(done as () => void);
    return true;
  }) as typeof process.stdout.write;

  process.stdout.write = patched;

  return {
    stop(): string {
      if (!captured) return chunks.join('');
      captured = false;
      if (process.stdout.write === patched) process.stdout.write = original;
      return chunks.join('');
    },
  };
}

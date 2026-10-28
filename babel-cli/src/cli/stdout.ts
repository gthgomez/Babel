import { writeSync } from 'node:fs';

const BROKEN_STDOUT_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ENOTCONN']);
const stdoutRetryWait = new Int32Array(new SharedArrayBuffer(4));
let stdoutBroken = false;
let stdoutGuardInstalled = false;

function isBrokenStdoutError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    BROKEN_STDOUT_CODES.has(String((error as { code?: unknown }).code ?? ''))
  );
}

function ensureStdoutErrorGuard(): void {
  if (stdoutGuardInstalled) {
    return;
  }
  stdoutGuardInstalled = true;
  process.stdout.on('error', (error) => {
    if (isBrokenStdoutError(error)) {
      stdoutBroken = true;
      return;
    }
    throw error;
  });
}

/** Deliver complete UTF-8 output before immediate CLI exit, honoring pipe backpressure. */
export function writeStdout(text: string): void {
  if (stdoutBroken) {
    return;
  }
  ensureStdoutErrorGuard();
  try {
    // Use synchronous fd-level write to avoid buffered Writable stream
    // data loss when process.exit() follows immediately after writeJson().
    if (process.stdout.fd !== undefined) {
      const bytes = Buffer.from(text, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        try {
          const written = writeSync(process.stdout.fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error('stdout write made no progress');
          offset += written;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'EAGAIN') throw error;
          // POSIX stdout pipes are nonblocking. Wait for the external reader
          // without spinning or abandoning bytes before an immediate exit.
          Atomics.wait(stdoutRetryWait, 0, 0, 1);
        }
      }
    } else {
      process.stdout.write(text);
    }
  } catch (error) {
    if (isBrokenStdoutError(error)) {
      stdoutBroken = true;
      return;
    }
    throw error;
  }
}

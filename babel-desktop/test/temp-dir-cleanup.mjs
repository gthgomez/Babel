import { rm } from 'node:fs/promises';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Windows CI can hold temp dirs until owned children exit; fail cleanup only after bounded retries. */
export async function rmTempDirWithOwnedChildDrain(
  path,
  { attempts = 10, baseDelayMs = 200, onRetry } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(path, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: baseDelayMs,
      });
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === 'object' ? error.code : undefined;
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
      if (onRetry) onRetry({ attempt, code, message, path });
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error;
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
  const code = lastError && typeof lastError === 'object' ? lastError.code : undefined;
  const message = lastError && typeof lastError === 'object' && 'message' in lastError ? String(lastError.message) : String(lastError);
  throw Object.assign(new Error(message), { code });
}

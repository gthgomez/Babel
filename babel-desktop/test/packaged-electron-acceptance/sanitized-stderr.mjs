// License: Apache-2.0
// Retain only a bounded prefix in memory and publish fixed classifications, never raw stderr.
const spawnCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM', 'ENOSPC', 'EINVAL']);
const signals = new Set(['SIGABRT', 'SIGBREAK', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2']);
export const sanitizeSpawnCode = value => value == null ? null : (spawnCodes.has(value) ? value : 'other');
export const sanitizeSignal = value => value == null ? null : (signals.has(value) ? value : 'other');

export function captureSanitizedStderr(stream) {
  let prefix = Buffer.alloc(0), seen = 0, streamError = false;
  stream.on('error', () => { streamError = true; });
  stream.on('data', chunk => {
    seen += chunk.length;
    if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
  });
  return () => {
    const text = prefix.toString('utf8');
    const categories = [];
    if (/console|terminal|standard handle/i.test(text)) categories.push('console');
    if (/invalid handle|handle is invalid|0x80070006/i.test(text)) categories.push('invalid-handle');
    if (/failed to create coreclr|clr initialization/i.test(text)) categories.push('runtime-initialization');
    if (/access.{0,20}denied|unauthori[sz]ed/i.test(text)) categories.push('access-denied');
    if (/parsererror|runtimeexception/i.test(text)) categories.push('powershell-error');
    if (/exception|error|fatal/i.test(text)) categories.push('error');
    if (seen && !categories.length) categories.push('other');
    const rawHresult = /\bHRESULT\s*:\s*(0x[0-9a-f]{8})\b/i.exec(text)?.[1]?.toLowerCase();
    const hresult = rawHresult ? (rawHresult === '0x80070006' ? '0x80070006' : 'other') : null;
    return {capturedBytes: prefix.length, truncated: seen > prefix.length, categories, hresult, streamError};
  };
}

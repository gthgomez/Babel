/**
 * Test-process-only PATH hygiene for host tool resolution in authority suites.
 *
 * Cloud agent images may prepend `/exec-daemon/*` ahead of distro-owned tools.
 * The command resolver correctly treats those identities as untrusted; unit tests
 * that exercise `git`/`gh` capability decoding must resolve the installed trusted
 * host binaries instead.
 *
 * Opt out: `BABEL_TEST_TRUSTED_HOST_TOOL_PATH=0`
 * Override trusted roots: `BABEL_TEST_TRUSTED_HOST_TOOL_PATH=/usr/bin:/bin` (prepend only)
 *
 * Does not mutate persistent shell PATH, resolver policy, or credentials.
 */
const EXEC_DAEMON_SEGMENT = /(?:^|:)(\/exec-daemon(?:\/|$)|.*[/\\]exec-daemon(?:[/\\]|$))/;

export function preferTrustedHostToolPathForTests() {
  if (process.env.BABEL_TEST_TRUSTED_HOST_TOOL_PATH === '0') {
    return;
  }
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const current = (process.env[pathKey] ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
  const filtered = current.filter((entry) => {
    const normalized = process.platform === 'win32' ? entry.replace(/\\/g, '/').toLowerCase() : entry;
    return !normalized.includes('/exec-daemon/') && !normalized.startsWith('/exec-daemon')
      && !normalized.endsWith('/exec-daemon');
  });
  const configured = (process.env.BABEL_TEST_TRUSTED_HOST_TOOL_PATH ?? '').trim();
  const trustedPrefixes = configured && configured !== '0' && configured !== '1'
    ? configured.split(delimiter).map((entry) => entry.trim()).filter(Boolean)
    : process.platform === 'win32'
      ? []
      : ['/usr/bin', '/bin'];
  const seen = new Set();
  const merged = [];
  for (const entry of [...trustedPrefixes, ...filtered]) {
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  if (merged.length === 0) return;
  process.env[pathKey] = merged.join(delimiter);
}

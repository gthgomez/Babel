/** Test-owned CLI shim: redirect production `remote serve` to acceptance-bridge with isolated env. */
export function rewriteArgvForAcceptanceBridge(argv) {
  const next = [...argv];
  const remoteIdx = next.indexOf('remote');
  if (remoteIdx < 0) return { argv: next, remoteSub: '' };
  const remoteSub = next[remoteIdx + 1] ?? '';
  if (remoteSub === 'serve') {
    next[remoteIdx + 1] = 'acceptance-bridge';
    return { argv: next, remoteSub: 'acceptance-bridge' };
  }
  return { argv: next, remoteSub };
}

export function childEnvForRemoteSub(remoteSub, baseEnv) {
  const env = { ...baseEnv };
  if (remoteSub === 'acceptance-bridge') {
    env.BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE = '1';
  }
  return env;
}

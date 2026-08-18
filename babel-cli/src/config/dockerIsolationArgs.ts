/**
 * Single validator for BABEL_BENCHMARK_DOCKER_EXTRA_ARGS.
 * Unsafe extras mean isolation is not actually Docker.
 */

export type DockerExtraArgsDecision =
  | { ok: true; args: string[] }
  | { ok: false; reason: string };

const SAFE_FLAGS = new Set([
  '--read-only',
  '--user',
  '--memory',
  '--memory-swap',
  '--cpus',
  '--cpu-shares',
  '--ulimit',
  '--name',
  '--label',
  '--tmpfs',
]);

const UNSAFE_EQ = /^(--privileged|--device|--cap-add|--pid|--userns|--mount|--volume|-v)(=|$)/i;

export function parseDockerExtraArgTokens(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

export function validateDockerIsolationArgs(
  raw: string | undefined | null = process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'],
): DockerExtraArgsDecision {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return { ok: true, args: [] };
  }
  const tokens = parseDockerExtraArgTokens(raw);
  if (tokens.length === 0) return { ok: true, args: [] };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith('-')) {
      return { ok: false, reason: `malformed docker extra arg: ${tok}` };
    }
    const [flag, inline] = tok.includes('=') ? [tok.slice(0, tok.indexOf('=')), tok.slice(tok.indexOf('=') + 1)] : [tok, undefined];
    const lower = flag.toLowerCase();

    if (lower === '--privileged') {
      return { ok: false, reason: 'docker extra arg --privileged weakens isolation' };
    }
    if (lower === '--network' || lower.startsWith('--network=')) {
      const value = lower.startsWith('--network=') ? flag.slice('--network='.length).toLowerCase() : (inline ?? tokens[i + 1] ?? '').toLowerCase();
      if (value !== 'none') {
        return { ok: false, reason: `docker extra arg --network ${value} weakens isolation` };
      }
      if (!lower.includes('=') && inline === undefined) i += 1;
      continue;
    }
    if (lower === '--pid' || lower.startsWith('--pid=')) {
      const value = (lower.startsWith('--pid=') ? flag.slice('--pid='.length) : (inline ?? tokens[i + 1] ?? '')).toLowerCase();
      if (value === 'host') return { ok: false, reason: 'docker extra arg --pid=host weakens isolation' };
      if (!lower.includes('=') && inline === undefined) i += 1;
      continue;
    }
    if (lower === '--userns' || lower.startsWith('--userns=')) {
      const value = (lower.startsWith('--userns=') ? flag.slice('--userns='.length) : (inline ?? tokens[i + 1] ?? '')).toLowerCase();
      if (value === 'host') return { ok: false, reason: 'docker extra arg --userns=host weakens isolation' };
      if (!lower.includes('=') && inline === undefined) i += 1;
      continue;
    }
    if (lower === '--cap-add' || lower.startsWith('--cap-add=')) {
      return { ok: false, reason: 'docker extra arg --cap-add weakens isolation' };
    }
    if (lower === '--device' || lower.startsWith('--device=')) {
      return { ok: false, reason: 'docker extra arg --device weakens isolation' };
    }
    if (lower === '--security-opt' || lower.startsWith('--security-opt=')) {
      const value = (lower.startsWith('--security-opt=') ? tok.slice(tok.indexOf('=') + 1) : (tokens[i + 1] ?? '')).toLowerCase();
      if (value.includes('unconfined') || value.includes('seccomp=unconfined')) {
        return { ok: false, reason: 'docker extra arg weakens seccomp' };
      }
      if (!tok.includes('=')) i += 1;
      continue;
    }
    if (lower === '-v' || lower === '--volume' || lower.startsWith('--volume=') || lower.startsWith('-v')) {
      return { ok: false, reason: 'docker extra arg bind mount weakens isolation' };
    }
    if (lower === '--mount' || lower.startsWith('--mount=')) {
      return { ok: false, reason: 'docker extra arg --mount weakens isolation' };
    }
    if (UNSAFE_EQ.test(tok)) {
      return { ok: false, reason: `docker extra arg ${tok} weakens isolation` };
    }
    const safeName = lower.split('=')[0] ?? lower;
    if (!SAFE_FLAGS.has(safeName)) {
      return { ok: false, reason: `unrecognized docker extra arg: ${flag}` };
    }
    if (!tok.includes('=') && SAFE_FLAGS.has(lower) && lower !== '--read-only') {
      i += 1;
    }
  }
  return { ok: true, args: tokens };
}

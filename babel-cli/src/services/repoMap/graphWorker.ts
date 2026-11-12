import type { RepoMapGraphOptions, RepoMapGraphOutcome } from './graph.js';

// Source checkouts register TypeScript module resolution before loading
// .js-named imports; packaged .js indexers have no tsx runtime dependency.
if (import.meta.url.endsWith('.ts')) {
  const { register } = await import('tsx/esm/api');
  register();
}

const {
  buildRepoMapGraphInWorker,
  invalidateRepoMapCache,
  invalidateRepoMapFile,
  RepoMapIoError,
  RepoMapLimitError,
} = await import('./graph.js');
const { buildLegacyRepoMapPreamble } = await import('./legacy.js');

type WorkerRequest =
  | { type: 'build'; id: number; root: string; options: Omit<RepoMapGraphOptions, 'signal' | 'maxDurationMs'> }
  | { type: 'invalidate'; file?: string };

process.on('disconnect', () => { process.exitCode = 0; });
process.on('message', (value: unknown) => {
  const request = value as WorkerRequest;
  if (request.type === 'invalidate') {
    if (request.file) invalidateRepoMapFile(request.file);
    else invalidateRepoMapCache();
    return;
  }
  process.send?.({ id: request.id, started: true });
  void (async () => {
    let outcome: RepoMapGraphOutcome;
    try {
      const result = await buildRepoMapGraphInWorker(request.root, request.options);
      outcome = result ? { status: 'ok', result } : { status: 'empty' };
    } catch (error) {
      outcome = error instanceof RepoMapLimitError
        ? { status: 'limited', reason: error.reason }
        : { status: 'failed', reason: error instanceof RepoMapIoError ? 'io_failure' : 'worker_failure' };
    }
    if (request.options.includeLegacyFallback && (outcome.status === 'empty' || outcome.status === 'limited')) {
      const fallback = await buildLegacyRepoMapPreamble(request.root);
      outcome = { ...outcome, fallback };
    }
    process.send?.({ id: request.id, outcome });
  })();
});

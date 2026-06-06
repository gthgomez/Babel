/**
 * Unified provider resolution for bl ask / plan / propose / fix lanes.
 * Maps workflow `--provider live|mock` to text-lane ids (`auto` | `mock`) and fix providers.
 */

export type LiteWorkflowProvider = 'live' | 'mock';

export interface LiteProviderAdapterOptions {
  provider?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedLiteProviders {
  /** Provider for runSmallFixPath and other mutation lanes. */
  fixProvider: LiteWorkflowProvider;
  /** Provider id for runLiteAsk / runLitePatch (`auto` selects configured API key). */
  textProviderId: string;
  /** True when mock/offline demo mode is active. */
  offlineDemo: boolean;
}

export interface LiteProviderAdapter {
  resolve(options?: LiteProviderAdapterOptions): ResolvedLiteProviders;
  resolveTextProviderId(options?: LiteProviderAdapterOptions): string;
  resolveFixProvider(options?: LiteProviderAdapterOptions): LiteWorkflowProvider;
}

export function normalizeLiteWorkflowProvider(value: string | undefined): LiteWorkflowProvider | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mock') {
    return 'mock';
  }
  if (normalized === 'live') {
    return 'live';
  }
  throw new Error(`Invalid provider "${value}". Valid values: live, mock`);
}

export function resolveLiteProviders(
  options: Pick<LiteProviderAdapterOptions, 'provider'>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLiteProviders {
  const explicit = normalizeLiteWorkflowProvider(options.provider);
  let fixProvider: LiteWorkflowProvider;
  if (explicit === 'live') {
    fixProvider = 'live';
  } else if (explicit === 'mock') {
    fixProvider = 'mock';
  } else if (env['BABEL_LITE_OFFLINE'] === '1' || env['BABEL_SMALL_FIX_PROVIDER'] === 'mock') {
    fixProvider = 'mock';
  } else {
    fixProvider = 'live';
  }

  return {
    fixProvider,
    textProviderId: fixProvider === 'mock' ? 'mock' : 'auto',
    offlineDemo: fixProvider === 'mock',
  };
}

/** @deprecated Use normalizeLiteWorkflowProvider — kept for workflow command tests. */
export const normalizeSmallFixProvider = normalizeLiteWorkflowProvider;

/** @deprecated Use resolveLiteProviders().fixProvider — kept for workflow command tests. */
export function resolveSmallFixProviderForCommand(
  options: Pick<LiteProviderAdapterOptions, 'provider'>,
  env: NodeJS.ProcessEnv = process.env,
): LiteWorkflowProvider {
  return resolveLiteProviders(options, env).fixProvider;
}

export function createLiteProviderAdapter(env: NodeJS.ProcessEnv = process.env): LiteProviderAdapter {
  return {
    resolve(options) {
      return resolveLiteProviders(
        { ...(options?.provider !== undefined ? { provider: options.provider } : {}) },
        options?.env ?? env,
      );
    },
    resolveTextProviderId(options) {
      return this.resolve(options).textProviderId;
    },
    resolveFixProvider(options) {
      return this.resolve(options).fixProvider;
    },
  };
}

export interface LiteOfflineEnvSnapshot {
  previousSmallFixProvider: string | undefined;
  previousLiteOffline: string | undefined;
}

export function snapshotLiteOfflineEnv(env: NodeJS.ProcessEnv = process.env): LiteOfflineEnvSnapshot {
  return {
    previousSmallFixProvider: env['BABEL_SMALL_FIX_PROVIDER'],
    previousLiteOffline: env['BABEL_LITE_OFFLINE'],
  };
}

export function applyLiteOfflineEnv(
  fixProvider: LiteWorkflowProvider,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (fixProvider === 'mock') {
    env['BABEL_SMALL_FIX_PROVIDER'] = 'mock';
    env['BABEL_LITE_OFFLINE'] = '1';
  }
}

export function restoreLiteOfflineEnv(
  snapshot: LiteOfflineEnvSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (snapshot.previousSmallFixProvider === undefined) {
    delete env['BABEL_SMALL_FIX_PROVIDER'];
  } else {
    env['BABEL_SMALL_FIX_PROVIDER'] = snapshot.previousSmallFixProvider;
  }
  if (snapshot.previousLiteOffline === undefined) {
    delete env['BABEL_LITE_OFFLINE'];
  } else {
    env['BABEL_LITE_OFFLINE'] = snapshot.previousLiteOffline;
  }
}

export function providerUsesOfflineEnv(verb: string): boolean {
  return verb === 'fix' || verb === 'propose' || verb === 'patch' || verb === 'diff';
}

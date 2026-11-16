import { loadBabelCliEnv } from '../config/envBootstrap.js';
import { conversationScopeRequested } from '../config/conversationScope.js';
import { isDesktopCapabilityProbe } from '../config/desktopCapabilities.js';
import { withInvocationSettings } from '../config/invocationSettings.js';
import { withProductProviderPolicy } from '../runners/providerRegistry.js';

/** Bootstrap is shared by the full command tree and the plain interactive path. */
export function bootstrapCliEnvironment(argv: string[]): void {
  if (isDesktopCapabilityProbe(argv)) return;
  loadBabelCliEnv(process.env, undefined, {
    executionScope: conversationScopeRequested(argv) ? 'conversation' : 'project',
  });
  process.env['BABEL_ENV_LOADED'] = 'true';
}

export function withCliInvocation<T>(work: () => T): T {
  return withProductProviderPolicy(() => withInvocationSettings({}, work));
}

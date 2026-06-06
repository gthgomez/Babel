/**
 * Internal text-provider lane — not the product definition of Babel Lite.
 * Re-exports provider-contract behavior and unified adapter for proposal/ask artifacts.
 */
export {
  createLiteProviderAdapter,
  normalizeLiteWorkflowProvider,
  normalizeSmallFixProvider,
  providerUsesOfflineEnv,
  resolveLiteProviders,
  resolveSmallFixProviderForCommand,
  applyLiteOfflineEnv,
  restoreLiteOfflineEnv,
  snapshotLiteOfflineEnv,
  type LiteProviderAdapter,
  type LiteProviderAdapterOptions,
  type LiteWorkflowProvider,
  type ResolvedLiteProviders,
} from './liteProviderAdapter.js';

export {
  runLiteAsk,
  runLitePatch,
  runLitePlan,
  runLiteProviders,
  formatLiteAskText,
  formatLitePatchText,
  formatLitePlanText,
  formatLiteProvidersText,
} from '../../lite/commands.js';

/**
 * Deep mode adapter — explicit unsupported surface.
 *
 * Deep must run the real V9 pipeline; until that adapter is wired to this
 * surface, Deep is rejected rather than silently executed as a Chat engine
 * carrying a `deep` execution profile (P02 contract, V04). This adapter exists
 * so the coordinator has a named Deep boundary instead of a missing branch, and
 * so the rejection is explicit and typed.
 */

import { resolveModeCapability } from '../../executor/modeAdapters.js';
import {
  RuntimeModeUnsupportedError,
  type RuntimeModeAdapter,
  type RuntimeTurnRequest,
} from '../contracts.js';

/** Deep controller: reserved for the V9 pipeline; not wired here yet. */
export function createDeepRuntimeAdapter(): RuntimeModeAdapter {
  const capability = resolveModeCapability('deep');

  return {
    mode: 'deep',
    controller: 'v9_pipeline',
    capability,
    async *submit(_request: RuntimeTurnRequest) {
      throw new RuntimeModeUnsupportedError(
        'deep',
        capability.reason ??
          'The V9 pipeline controller is not wired to this surface yet',
      );
    },
    async cancel(_request: RuntimeTurnRequest) {
      // No Deep execution can be admitted on this surface, so there is nothing
      // to cancel. Kept explicit so a future V9 adapter has a defined seam.
    },
  };
}

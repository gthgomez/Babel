import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import type { ClaudeHarnessProviderProfile } from './claudeCodeAdmission.js';

/** Non-secret profile markers merged into the child env (no provider routes). */
export function profileChildEnvMarkers(
  profile: ClaudeHarnessProviderProfile,
): Record<string, string> {
  switch (profile) {
    case EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat:
      return { BABEL_CLAUDE_PROFILE: profile, BABEL_CLAUDE_ROUTE_CLASS: 'command-code-goat' };
    case EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo:
      return { BABEL_CLAUDE_PROFILE: profile, BABEL_CLAUDE_ROUTE_CLASS: 'opencode-go' };
    default:
      return { BABEL_CLAUDE_PROFILE: profile };
  }
}

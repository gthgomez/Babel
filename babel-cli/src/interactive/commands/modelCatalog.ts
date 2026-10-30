import type { ModelPolicyModelEntry } from '../../modelPolicy.js';
import { getProviderCredentialStatus } from '../../runners/credentialHub.js';
import type { ProviderId } from '../../runners/providerRegistry.js';
import { accentBright, getTerminalWidth } from '../../ui/theme.js';
import { wrapPrefixedBlock } from '../../ui/textLayout.js';

export function formatModelPricing(entry: ModelPolicyModelEntry): string {
  const price = (n: number | undefined) => n === undefined ? 'unknown' : `$${n}/M`;
  return `Input ${price(entry.estimated_cost_per_1m_input)} · Output ${price(entry.estimated_cost_per_1m_output)} USD tokens`;
}

/** Configuration facts only: credential presence is not service availability. */
export function formatModelCatalog(
  models: { key: string; entry: ModelPolicyModelEntry }[],
  options: { activeKey?: string | undefined; width?: number; env?: NodeJS.ProcessEnv } = {},
): string {
  const width = options.width ?? getTerminalWidth();
  const lines = ['  Available Models:'];
  for (const { key, entry } of models) {
    const marker = key === options.activeKey ? '* ' : '  ';
    lines.push(...wrapPrefixedBlock(accentBright(key) + (key === options.activeKey ? ' (active)' : ''),
      { firstPrefix: `  ${marker}`, continuationPrefix: '    ', width: Math.max(12, width - 1) }));
    let availability = 'availability not checked';
    try {
      const status = getProviderCredentialStatus(entry.provider as ProviderId, options.env ?? process.env);
      availability = !status.required ? 'no API key required; availability not checked'
        : status.configured ? 'key configured; availability not checked' : `requires ${status.envVar}`;
    } catch { /* Unregistered providers retain an honest unknown status. */ }
    const tags = entry.capabilities?.slice(0, 3).join(', ');
    const details = `${entry.provider}${entry.experimental ? ' · experimental' : ''}${tags ? ` · ${tags}` : ''} · ${availability}\n${formatModelPricing(entry)}`;
    lines.push(...wrapPrefixedBlock(details, { firstPrefix: '    ', continuationPrefix: '    ', width: Math.max(12, width - 1) }));
  }
  lines.push(...wrapPrefixedBlock('Prices are policy estimates per million tokens; OpenRouter may route across endpoints with different prices. Rates can change; $0 is a configured rate, not a billing guarantee.',
    { firstPrefix: '  ', continuationPrefix: '  ', width: Math.max(12, width - 1) }));
  return lines.join('\n');
}

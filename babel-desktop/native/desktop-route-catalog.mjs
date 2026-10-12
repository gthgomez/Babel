// License: Apache-2.0 - see LICENSE
// Supported Desktop provider/model routes aligned with config/model-policy.json.

/** @typedef {{id:string, label:string, provider:string, requiresApiKey:boolean, local?:boolean, routes:readonly {id:string, label:string}[]}} DesktopProviderDescriptor */

export const DESKTOP_ROUTE_CATALOG = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek (cloud)',
    provider: 'deepseek',
    requiresApiKey: true,
    routes: Object.freeze([
      {id: 'deepseek-v4-pro', label: 'deepseek-v4-pro'},
    ]),
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter (cloud)',
    provider: 'openrouter',
    requiresApiKey: true,
    openRouter: true,
    routes: Object.freeze([
      {id: 'deepseek-v4-pro-openrouter', label: 'deepseek-v4-pro-openrouter'},
    ]),
  }),
  deepinfra: Object.freeze({
    id: 'deepinfra',
    label: 'DeepInfra (cloud)',
    provider: 'deepinfra',
    requiresApiKey: true,
    routes: Object.freeze([
      {id: 'deepseek-v4-flash', label: 'deepseek-v4-flash'},
    ]),
  }),
  ollama: Object.freeze({
    id: 'ollama',
    label: 'Ollama (local)',
    provider: 'ollama',
    requiresApiKey: false,
    local: true,
    routes: Object.freeze([
      {id: 'deepseek-v4-flash', label: 'deepseek-v4-flash (local)'},
    ]),
  }),
  opencode: Object.freeze({
    id: 'opencode',
    label: 'OpenCode Zen (cloud)',
    provider: 'opencode',
    requiresApiKey: true,
    routes: Object.freeze([
      {id: 'ox-alpha-free', label: 'ox-alpha-free (OpenCode Zen preview)'},
      {id: 'opencode-go/deepseek-v4.1-flash', label: 'opencode-go/deepseek-v4.1-flash (OpenCode Go)'},
    ]),
  }),
});

const PROVIDER_IDS = new Set(Object.keys(DESKTOP_ROUTE_CATALOG));

export function listDesktopProviderDescriptors() {
  return Object.values(DESKTOP_ROUTE_CATALOG).map(entry => ({
    id: entry.id,
    label: entry.label,
    requiresApiKey: entry.requiresApiKey,
    local: Boolean(entry.local),
    routes: entry.routes.map(route => ({id: route.id, label: route.label})),
  }));
}

/** @returns {{provider:string, model:string}} */
export function normalizeProviderRoute({provider, model} = {}) {
  if (!PROVIDER_IDS.has(provider)) {
    throw new Error('Select a supported, qualified provider route.');
  }
  const spec = DESKTOP_ROUTE_CATALOG[provider];
  const requested = typeof model === 'string' && model.trim() ? model.trim().slice(0, 120) : null;
  const allowed = new Set(spec.routes.map(route => route.id));
  const routeModel = requested && allowed.has(requested) ? requested : spec.routes[0].id;
  if (requested && !allowed.has(requested)) {
    throw new Error(`Model route "${requested}" is not supported for ${spec.label}.`);
  }
  return {provider, model: routeModel};
}

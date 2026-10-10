// License: Apache-2.0 - see LICENSE
// Desktop-selected provider/model route persisted in the private Babel profile.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

const ROUTE_FILE = 'desktop-routing.json';
const PROVIDERS = Object.freeze({
  deepseek: {credential: 'DEEPSEEK_API_KEY', backendKey: 'deepseek-v4-pro'},
  openrouter: {credential: 'OPENROUTER_API_KEY', backendKey: 'deepseek-v4-pro-openrouter', openRouter: true},
  deepinfra: {credential: 'DEEPINFRA_API_KEY', backendKey: 'deepseek-v4-flash'},
  ollama: {credential: null, backendKey: 'deepseek-v4-flash', local: true},
});

export function qualifiedProviders() {
  return Object.entries(PROVIDERS).map(([id, spec]) => ({
    id,
    requiresApiKey: Boolean(spec.credential),
    local: Boolean(spec.local),
  }));
}

function routingPath(configDirectory) {
  if (typeof configDirectory !== 'string' || !configDirectory) throw new Error('Configuration directory is unavailable.');
  return join(resolve(configDirectory), ROUTE_FILE);
}

export function readProviderRoute(configDirectory) {
  const path = routingPath(configDirectory);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const provider = typeof value.provider === 'string' ? value.provider : null;
    const model = typeof value.model === 'string' ? value.model : null;
    if (!provider || !Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) return null;
    return {provider, model};
  } catch {
    return null;
  }
}

export function saveProviderRoute({configDirectory, provider, model} = {}) {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    throw new Error('Select a supported, qualified provider route.');
  }
  const spec = PROVIDERS[provider];
  const routeModel = typeof model === 'string' && model.trim() ? model.trim().slice(0, 120) : spec.backendKey;
  const dir = resolve(configDirectory);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Configuration directory is unsafe.');
  const path = join(dir, ROUTE_FILE);
  const next = `${path}.next`;
  writeFileSync(next, JSON.stringify({provider, model: routeModel, updatedAt: new Date().toISOString()}, null, 2) + '\n', {mode: 0o600});
  renameSync(next, path);
  return {provider, model: routeModel};
}

/** Apply route env overrides for the CLI child without exposing secrets. */
export function applyProviderRoute(env, configDirectory) {
  const route = readProviderRoute(configDirectory);
  if (!route) return env;
  const spec = PROVIDERS[route.provider];
  if (spec.openRouter) {
    env.BABEL_LITE_OFFLINE = '0';
    env.BABEL_COMPACTION_MODEL = 'deepseek/deepseek-v4-pro';
    env.BABEL_DIFF_CRITIC_MODEL = 'deepseek/deepseek-v4-pro';
  }
  if (spec.local) env.BABEL_LITE_OFFLINE = '1';
  env.BABEL_DESKTOP_PROVIDER = route.provider;
  env.BABEL_DESKTOP_MODEL_ROUTE = route.model;
  return env;
}

// License: Apache-2.0 - see LICENSE
// Desktop-selected provider/model route persisted in the private Babel profile.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {DESKTOP_ROUTE_CATALOG, listDesktopProviderDescriptors, normalizeProviderRoute} from './desktop-route-catalog.mjs';

const ROUTE_FILE = 'desktop-routing.json';

export function qualifiedProviders() {
  return listDesktopProviderDescriptors();
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
    if (!provider || !Object.prototype.hasOwnProperty.call(DESKTOP_ROUTE_CATALOG, provider)) return null;
    if (!model) return null;
    try {
      return normalizeProviderRoute({provider, model});
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export function validateProviderRoute({provider, model} = {}) {
  return normalizeProviderRoute({provider, model});
}

export function saveProviderRoute({configDirectory, provider, model} = {}) {
  const route = normalizeProviderRoute({provider, model});
  const dir = resolve(configDirectory);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Configuration directory is unsafe.');
  const path = join(dir, ROUTE_FILE);
  const next = `${path}.next`;
  writeFileSync(next, JSON.stringify({...route, updatedAt: new Date().toISOString()}, null, 2) + '\n', {mode: 0o600});
  renameSync(next, path);
  return route;
}

/** Apply route env overrides for the CLI child without exposing secrets. */
export function applyProviderRoute(env, configDirectory) {
  const route = readProviderRoute(configDirectory);
  if (!route) return env;
  const spec = DESKTOP_ROUTE_CATALOG[route.provider];
  if (spec.openRouter) {
    env.BABEL_LITE_OFFLINE = '0';
    env.BABEL_COMPACTION_MODEL = 'deepseek/deepseek-v4-pro';
    env.BABEL_DIFF_CRITIC_MODEL = 'deepseek/deepseek-v4-pro';
  }
  if (spec.local) env.BABEL_LITE_OFFLINE = '1';
  else if (route.provider === 'opencode') env.BABEL_LITE_OFFLINE = '0';
  env.BABEL_DESKTOP_PROVIDER = route.provider;
  env.BABEL_DESKTOP_MODEL_ROUTE = route.model;
  return env;
}

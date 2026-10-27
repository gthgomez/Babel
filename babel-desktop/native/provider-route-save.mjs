// License: Apache-2.0 — see LICENSE
import {hasProviderCredential, saveProviderCredential} from './credentials.mjs';
import {qualifiedProviders, saveProviderRoute, validateProviderRoute} from './provider-routing.mjs';

/** Save a validated Desktop route and the user's explicit credential destination.
 * Credential, route, and preference writes are ordered, not a cross-file transaction.
 */
export async function saveDesktopProviderRoute({options, configDirectory, preferences, savePreferences}) {
  if (!options || typeof options !== 'object') throw new Error('Invalid provider route request.');
  const route = validateProviderRoute(options,configDirectory);
  const scope = options.scope ?? 'private';
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
  if ((scope !== 'private' && scope !== 'project') || (apiKey && !options.scope)) {
    throw new Error('Select an explicit credential destination.');
  }
  if (scope === 'project' && !preferences.projectRoot) {
    throw new Error('Select a project before choosing project-local credentials.');
  }
  const requiresKey = Boolean(qualifiedProviders().find(entry => entry.id === route.provider)?.requiresApiKey);
  if (requiresKey && !apiKey && !hasProviderCredential({
    configDirectory, provider: route.provider, scope, projectRoot: preferences.projectRoot,
  })) throw new Error('Enter a provider API key or keep the existing saved credential.');
  if (apiKey) saveProviderCredential({
    provider: route.provider, apiKey, scope, configDirectory, projectRoot: preferences.projectRoot, operation:options.credentialOperation??'add',
  });
  saveProviderRoute({configDirectory, ...route,enabledModels:options.enabledModels,manualModelId:options.manualModelId});
  const previousRoot = preferences.projectCredentialRoot;
  preferences.projectCredentialRoot = scope === 'project' ? preferences.projectRoot : null;
  try { await savePreferences(); }
  catch (error) {
    // Keep the running process on its last persisted opt-in when preferences fail.
    preferences.projectCredentialRoot = previousRoot;
    throw error;
  }
  return {route, credentialUpdated: Boolean(apiKey)};
}

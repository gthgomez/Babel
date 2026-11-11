// License: Apache-2.0 — see LICENSE
import {saveProviderCredential, providerCredentialStatus, normalizeCredentialOperation} from './credentials.mjs';
import {qualifiedProviders, saveProviderRoute, validateProviderRoute} from './provider-routing.mjs';

/**
 * Save a validated Desktop route and the user's explicit credential decision.
 *
 * Credential, model-policy, route and preference are separate files. This is an
 * ordered, observable sequence — never a cross-file transaction. Every outcome is
 * a structured serializable envelope: Electron IPC does not reliably preserve
 * custom Error fields, so callers must not depend on a thrown error's `code`.
 */
export async function saveDesktopProviderRoute({options, configDirectory, preferences, savePreferences, checkConnection=null}) {
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
  const before = requiresKey
    ? providerCredentialStatus({configDirectory,provider:route.provider,scope,projectRoot:preferences.projectRoot})
    : {present:false,storage:'none',credentialRevision:null,credentialIdentity:null};
  // Every branch below is prevalidated; nothing after this point can reject the
  // request for a reason the user could have been told about before writing.
  const action = resolveAction({options,apiKey,before,requiresKey});
  if (requiresKey && !apiKey && action !== 'keep_existing_route_only' && action !== 'continue_with_legacy' && !before.present) {
    throw new Error('Enter a provider API key or keep the existing saved credential.');
  }
  // A key the user typed must never be silently discarded by an action that
  // does not write it. They would believe a new key is stored when it is not.
  if (apiKey && (action === 'keep_existing_route_only' || action === 'continue_with_legacy')) {
    throw new Error('This action keeps the existing credential, so the new key was not saved. Choose Add or Replace to store it.');
  }
  // A blank key on a legacy-only profile is never an unqualified first-run
  // success: only an explicit `continue_with_legacy` may keep using plaintext.
  const legacyOnly = before.storage === 'legacy-plaintext' && !before.ownedProtectedEntry;
  if (requiresKey && legacyOnly && (action === 'keep_existing_route_only' || action === 'add_new' || action === 'replace_protected')) {
    throw new Error('Only a legacy plaintext key is stored. Choose to replace it with OS-protected storage, or deliberately continue using the unverified legacy key.');
  }

  const persisted = {credential:false,modelPolicy:false,route:false,preferences:false};
  let credential = null;
  if (requiresKey && (apiKey || action === 'continue_with_legacy')) {
    try {
      credential = saveProviderCredential({
        provider: route.provider, apiKey, scope, configDirectory,
        projectRoot: preferences.projectRoot, operation:action,
      });
      persisted.credential = action !== 'continue_with_legacy';
    } catch (error) {
      return failure({code:'credential_write_failed',error,persisted,retryable:true,recoveryAction:'Review the credential destination, then retry. Your key was not stored.'});
    }
  }

  // Read back what actually persisted before claiming any later stage.
  try { saveProviderRoute({configDirectory, ...route, enabledModels:options.enabledModels, manualModelId:options.manualModelId}); persisted.modelPolicy = true; persisted.route = true; }
  catch (error) {
    return failure({code:'route_write_failed',error,persisted,retryable:true,credential,recoveryAction:'Retry the save. The credential and any earlier file that succeeded are retained; nothing was rolled back.'});
  }

  const previousRoot = preferences.projectCredentialRoot;
  preferences.projectCredentialRoot = scope === 'project' ? preferences.projectRoot : null;
  try { await savePreferences(); persisted.preferences = true; }
  catch (error) {
    // Keep the running process on its last persisted opt-in when preferences fail.
    preferences.projectCredentialRoot = previousRoot;
    return failure({code:'preferences_write_failed',error,persisted,retryable:true,credential,recoveryAction:'Retry the save. The credential and route are already stored; only the Desktop preference failed.'});
  }

  const authState = credential?.storage === 'legacy-plaintext' ? 'legacy_unverified' : 'not_checked';
  let authentication = null;
  if (checkConnection && credential?.storage !== 'legacy-plaintext' && persisted.credential !== false) {
    try { authentication = await checkConnection({provider:route.provider,scope}); }
    catch { authentication = {state:'unavailable',reason:'check_failed'}; }
  }
  return {
    ok:true,
    route,
    credentialChanged: Boolean(credential?.credentialChanged),
    credentialUpdated: Boolean(credential?.credentialChanged), // earlier renderer compat alias
    storage: credential?.storage ?? before.storage,
    // Report the identity the credential actually has now, not a stale revision.
    revision: credential?.revision ?? before.credentialIdentity ?? before.credentialRevision ?? null,
    authState: authentication?.state ?? authState,
    authentication,
    persisted,
    recoveryAction:null,
  };
}

/** Choose the credential action from the observed state, never from a guess. */
function resolveAction({options,apiKey,before,requiresKey}){
  const requested = options.credentialOperation === undefined ? null : normalizeCredentialOperation(options.credentialOperation);
  if (!requiresKey) return 'keep_existing_route_only';
  if (requested) {
    // A first-run legacy-only profile must consent explicitly; the default
    // `add` must not silently imply supersede.
    return requested;
  }
  if (!apiKey) return 'keep_existing_route_only';
  return before.present ? 'replace_protected' : 'add_new';
}

function failure({code,error,persisted,retryable,credential=null,recoveryAction}){
  const message = typeof error?.message === 'string' && error.message ? error.message : 'The save did not complete.';
  return {
    ok:false,
    code,
    safeMessage:message,
    retryable,
    // Unknown stays unknown: a failed write may or may not have committed.
    persisted,
    credentialChanged:false,
    storage:credential?.storage ?? 'unknown',
    revision:credential?.revision ?? null,
    recoveryAction,
  };
}

/** Truthful verification of what is actually on disk after an uncertain save. */
export function reconcileProviderRoute({configDirectory, provider, scope='private', projectRoot=null, preferences}={}){
  let status=null;
  try{status=providerCredentialStatus({configDirectory,provider,scope,projectRoot});}catch{status=null;}
  return {
    credential:status?{present:status.present,storage:status.storage,revision:status.credentialRevision}:null,
    projectCredentialRoot:preferences?.projectCredentialRoot??null,
  };
}

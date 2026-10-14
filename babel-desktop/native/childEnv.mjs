// License: Apache-2.0 - see LICENSE
// Environment shaping for the Babel CLI child process. Kept pure so the
// credential-scope gate can be tested without launching Electron.

/**
 * Apply the project-credential scope to a CLI child environment, in place.
 *
 * A selected project's credentials are NEVER inherited ambiently: any
 * inherited `BABEL_PROJECT_CREDENTIALS_DIR` is always stripped, and the
 * variable is exposed only when the user has explicitly opted the currently
 * selected project into project-local credential storage (the opted-in root
 * must equal the selected project root). This prevents one project, or an
 * ambient variable, from exposing another project's `.env` to the CLI.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{projectCredentialRoot?: string|null, projectRoot?: string|null}} scope
 * @returns {NodeJS.ProcessEnv} the same env object, for convenience
 */
import {applyProviderRoute} from './provider-routing.mjs';

/** Bind auxiliary calls to the validated provider model ID for this run. */
export function applySelectedModelEnvironment(env, model) {
  if (!model || typeof model.modelId !== 'string' || !/^[\w./:+-]{1,200}$/.test(model.modelId)) throw new TypeError('A qualified provider model ID is required');
  env.BABEL_COMPACTION_MODEL=model.modelId;
  env.BABEL_DIFF_CRITIC_MODEL=model.modelId;
  env.BABEL_DIFF_CRITIC_PRO_MODEL=model.modelId;
  // Auxiliary credentials/endpoints cannot override the selected provider.
  delete env.BABEL_COMPACTION_API_KEY;
  delete env.BABEL_COMPACTION_API_BASE;
  return env;
}

export function applyProjectCredentialScope(env, {projectCredentialRoot = null, projectRoot = null, configDirectory = null} = {}) {
  delete env.BABEL_PROJECT_CREDENTIALS_DIR;
  if (projectRoot && projectCredentialRoot === projectRoot) {
    env.BABEL_PROJECT_CREDENTIALS_DIR = projectRoot;
  }
  if (configDirectory) applyProviderRoute(env, configDirectory);
  return env;
}

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
export function applyProjectCredentialScope(env, {projectCredentialRoot = null, projectRoot = null} = {}) {
  delete env.BABEL_PROJECT_CREDENTIALS_DIR;
  if (projectRoot && projectCredentialRoot === projectRoot) {
    env.BABEL_PROJECT_CREDENTIALS_DIR = projectRoot;
  }
  return env;
}

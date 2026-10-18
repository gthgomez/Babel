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
import {applyNativeCredentialEnvironment,assertStandaloneCredentialCompatibility} from './credentials.mjs';
import {isAbsolute,resolve} from 'node:path';

export {applySelectedModelEnvironment} from './provider-routing.mjs';

/** Conversation authority comes from its explicit CLI argument, never ambient roots. */
export function applyExecutionScopeEnvironment(env,scope) {
  if(scope?.kind==='conversation')for(const name of ['BABEL_PROJECT_ROOT','BABEL_ALLOWED_ROOTS','BABEL_PROJECT_CREDENTIALS_DIR','BABEL_LEGACY_CLI_ENV'])delete env[name];
  return env;
}

export function applyProjectCredentialScope(env, {projectCredentialRoot = null, projectRoot = null, configDirectory = null} = {}) {
  delete env.BABEL_PROJECT_CREDENTIALS_DIR;
  if (projectRoot && projectCredentialRoot === projectRoot) {
    env.BABEL_PROJECT_CREDENTIALS_DIR = projectRoot;
  }
  if (configDirectory) applyProviderRoute(env, configDirectory);
  // Local inference needs no project credentials, including an absent project .env.
  if (env.BABEL_DESKTOP_PROVIDER==='ollama') delete env.BABEL_PROJECT_CREDENTIALS_DIR;
  return env;
}

/** Bind installed CLI credentials to its requested root, never task text or another named project. */
export function applyCliCredentialScope(env, {args = [], cwd = process.cwd(), preferences = {}, configDirectory = null} = {}) {
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0,separator);
  let requested = cwd, explicitRoot = false, namedProject = false;
  for (let index=0;index<options.length;index++) {
    const arg=options[index];
    if(arg==='--project-root') {explicitRoot=true;requested=options[++index];}
    else if(arg.startsWith('--project-root=')) {explicitRoot=true;requested=arg.slice('--project-root='.length);}
    else if(arg==='--project'||arg.startsWith('--project=')||arg.startsWith('-p')) namedProject=true;
  }
  const valid = typeof requested==='string' && requested.length>0 && requested.length<2048 && !requested.includes('\0') && !requested.startsWith('-');
  // Legacy plan/deep/ask positional syntax can name another project. Require
  // an explicit root for those commands rather than guessing from their task.
  const cwdUnambiguous = options.length===0 || ['run','interactive','doctor'].includes(options[0]);
  const projectRoot = valid && (explicitRoot || (!namedProject&&cwdUnambiguous)) ? resolve(cwd,requested) : null;
  const opted = preferences.projectCredentialRoot;
  const projectCredentialRoot = typeof opted==='string' && isAbsolute(opted) ? resolve(opted) : null;
  applyProjectCredentialScope(env,{projectRoot,projectCredentialRoot,configDirectory});
  if(configDirectory)assertStandaloneCredentialCompatibility(configDirectory);
  return env;
}

/** Main-process opt-in only. Node launchers cannot unlock Electron safeStorage. */
export function applyOwnedCliCredentialEnvironment(env,{configDirectory,projectRoot=null,projectCredentialRoot=null}={}) {
  return applyNativeCredentialEnvironment(env,{provider:env.BABEL_DESKTOP_PROVIDER??'ollama',configDirectory,
    scope:projectRoot&&projectCredentialRoot===projectRoot?'project':'private',projectRoot});
}

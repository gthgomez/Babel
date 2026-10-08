// License: Apache-2.0 — see LICENSE
import { join } from 'node:path'

/** Isolate installed-product children from inherited provider, config, credentials and preloads. */
export function consumerEnvironment(inherited, scratch) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^(?:BABEL_|OPENCODE_|NPM_CONFIG_|OPENAI_|ANTHROPIC_|OPENROUTER_|DEEPSEEK_|DEEPINFRA_|OLLAMA_|GEMINI_)/i.test(key) &&
    !/(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key) &&
    !/^(?:NODE_OPTIONS|NODE_PATH|NODE_ENV|CI|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_STATE_HOME|XDG_CACHE_HOME|TMPDIR|TMP|TEMP)$/i.test(key)))
  const user = join(scratch, 'user space')
  Object.assign(env, { HOME: user, USERPROFILE: user, APPDATA: join(scratch, 'app-data'),
    LOCALAPPDATA: join(scratch, 'local-app-data'), NODE_ENV: 'production',
    BABEL_CONFIG_DIR: join(scratch, 'config area ü'), BABEL_STATE_DIR: join(scratch, 'state area ü'),
    BABEL_CACHE_DIR: join(scratch, 'cache area ü'), BABEL_DRY_RUN: '1',
    BABEL_ROOT: join(scratch, 'invalid source override'), BABEL_SKIP_RESUME_PICKER: '1',
    XDG_CONFIG_HOME: join(scratch, 'xdg-config'), XDG_STATE_HOME: join(scratch, 'xdg-state'),
    XDG_CACHE_HOME: join(scratch, 'xdg-cache'), npm_config_cache: join(scratch, 'npm-cache'),
    npm_config_userconfig: join(scratch, 'empty-npmrc'), npm_config_globalconfig: join(scratch, 'empty-global-npmrc'),
    TMPDIR: scratch, TMP: scratch, TEMP: scratch })
  return env
}

// License: Apache-2.0 — see LICENSE
import { join } from 'node:path'

const inheritedRuntimeKeys = new Map([
  ['PATH', 'PATH'], ['PATHEXT', 'PATHEXT'], ['COMSPEC', 'ComSpec'],
  ['SYSTEMROOT', 'SystemRoot'], ['WINDIR', 'WINDIR'],
  ['LANG', 'LANG'], ['LANGUAGE', 'LANGUAGE'], ['LC_ALL', 'LC_ALL'],
  ['LC_CTYPE', 'LC_CTYPE'], ['LC_MESSAGES', 'LC_MESSAGES'],
  ['PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITECTURE'],
  ['PROCESSOR_IDENTIFIER', 'PROCESSOR_IDENTIFIER'], ['PROCESSOR_LEVEL', 'PROCESSOR_LEVEL'],
  ['PROCESSOR_REVISION', 'PROCESSOR_REVISION'], ['NUMBER_OF_PROCESSORS', 'NUMBER_OF_PROCESSORS'],
])

/** Isolate installed-product children from inherited provider, config, credentials and preloads. */
export function consumerEnvironment(inherited, scratch) {
  const windows = process.platform === 'win32'
  const env = {}
  for (const [key, value] of Object.entries(inherited)) {
    const allowedName = inheritedRuntimeKeys.get(key.toUpperCase())
    if (!allowedName || (!windows && key !== allowedName)) continue
    if (windows && Object.hasOwn(env, allowedName)) {
      throw new Error(`Duplicate inherited runtime environment key: ${allowedName}`)
    }
    env[allowedName] = value
  }
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

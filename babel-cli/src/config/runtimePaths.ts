import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RuntimePaths {
  packageRoot: string
  resourceRoot: string
  isInstalled: boolean
  userConfigRoot: string
  userStateRoot: string
  userCacheRoot: string
  targetProjectRoot: string
}

const ownPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function sourceRoot(packageRoot: string): string {
  let current = packageRoot
  while (true) {
    if (existsSync(join(current, 'prompt_catalog.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) return dirname(packageRoot)
    current = parent
  }
}

/** Resolve immutable assets, writable user directories, and target cwd at call time. */
export function resolveRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  packageRoot: string = ownPackageRoot,
): RuntimePaths {
  packageRoot = resolve(packageRoot)
  // Prepack stages resources in source checkouts; only the shipped package lacks src.
  const isInstalled = existsSync(join(packageRoot, 'resources', 'prompt_catalog.yaml')) &&
    !existsSync(join(packageRoot, 'src', 'index.ts'))
  const resourceRoot = isInstalled
    ? join(packageRoot, 'resources')
    : resolve(env['BABEL_ROOT'] || sourceRoot(packageRoot))
  const userRoot = join(env['USERPROFILE'] || env['HOME'] || homedir(), '.babel')
  return {
    packageRoot,
    resourceRoot,
    isInstalled,
    userConfigRoot: resolve(env['BABEL_CONFIG_DIR'] || (isInstalled ? join(userRoot, 'config') : join(resourceRoot, 'config'))),
    userStateRoot: resolve(env['BABEL_STATE_DIR'] || (isInstalled ? userRoot : resourceRoot)),
    userCacheRoot: resolve(env['BABEL_CACHE_DIR'] || (isInstalled ? join(userRoot, 'cache') : join(resourceRoot, 'runtime', 'cache'))),
    targetProjectRoot: resolve(env['BABEL_PROJECT_ROOT'] || process.cwd()),
  }
}

/** Resolve run artifacts independently from the immutable resource root. */
export function resolveRuntimeRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['BABEL_RUNS_DIR'] || join(resolveRuntimePaths(env).userStateRoot, 'runs'))
}

/** Read a user configuration override, falling back to the packaged default. */
export function resolveRuntimeConfigPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const paths = resolveRuntimePaths(env)
  const userPath = join(paths.userConfigRoot, name)
  return existsSync(userPath) ? userPath : join(paths.resourceRoot, 'config', name)
}

/** Resolve local learning state, retaining explicit source-library root semantics. */
export function resolveRuntimeLearningRoot(
  babelRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  packageRoot: string = ownPackageRoot,
): string {
  const paths = resolveRuntimePaths(env, packageRoot)
  const runsRoot = paths.isInstalled
    ? resolve(env['BABEL_RUNS_DIR'] || join(paths.userStateRoot, 'runs'))
    : join(babelRoot, 'runs')
  return join(runsRoot, 'local-learning')
}

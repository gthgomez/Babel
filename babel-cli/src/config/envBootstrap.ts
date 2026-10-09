import { resolveRuntimePaths } from './runtimePaths.js';
import { config as dotenvConfig, parse as dotenvParse } from 'dotenv';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { listProviderSpecs } from '../runners/providerRegistry.js';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the babel-cli package root (directory containing package.json and .env). */
export const BABEL_CLI_PACKAGE_ROOT = resolve(__dirname, '../..');

/** Secrets default to a private user directory even for source-checkout runs. */
export function resolvePrivateCredentialEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['USERPROFILE'] || env['HOME'] || homedir();
  return resolve(env['BABEL_CONFIG_DIR'] || join(home, '.babel', 'config'), '.env');
}

export const BABEL_CLI_ENV_FILE_PATH = resolvePrivateCredentialEnvPath();

let envFileLoadAttempted = false;
let envFileLoaded = false;

function isEnvValueActive(key: string, env: NodeJS.ProcessEnv): boolean {
  const value = env[key];
  return value !== undefined && value !== '';
}

/** Parse non-comment keys from a dotenv file that declare a non-empty value. */
export function parseEnvFileKeys(envFilePath: string): string[] {
  if (!existsSync(envFilePath)) {
    return [];
  }

  const parsed = dotenvParse(readFileSync(envFilePath, 'utf8'));
  return Object.entries(parsed)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key]) => key);
}

function gitAllowsIgnoredProjectEnv(root: string): boolean {
  const run = (args: string[]): number | null => spawnSync('git', ['-C', root, ...args], {
    timeout: 4000, windowsHide: true, stdio: 'ignore',
  }).status;
  return run(['rev-parse', '--is-inside-work-tree']) === 0 &&
    run(['ls-files', '--error-unmatch', '--', '.env']) !== 0 &&
    run(['check-ignore', '-q', '--', '.env']) === 0;
}

/** Never auto-load project .env: only a trusted client may opt in for one root. */
export function loadOptedInProjectCredentials(env: NodeJS.ProcessEnv): boolean {
  const selectedRoot = env['BABEL_PROJECT_CREDENTIALS_DIR'];
  if (!selectedRoot) return false;
  if (!isAbsolute(selectedRoot)) throw new Error('Project credential root must be absolute');
  const root = resolve(selectedRoot);
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error('Project credential root must be a real, non-linked directory');
  }
  if (!gitAllowsIgnoredProjectEnv(root)) {
    throw new Error('Project .env is not confirmed ignored and untracked');
  }
  const file = join(root, '.env');
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 256 * 1024) {
    throw new Error('Project .env is not a safe regular file');
  }
  const values = dotenvParse(readFileSync(file, 'utf8'));
  // A project may supply only certified provider credentials, not arbitrary
  // NODE_OPTIONS, BABEL_ROOT, execution-policy or process-control variables.
  for (const spec of listProviderSpecs()) {
    if (spec.authorityConformance !== 'certified' || !spec.credentialEnvVar) continue;
    const name = spec.credentialEnvVar;
    if (!env[name] && typeof values[name] === 'string' && values[name]) env[name] = values[name];
  }
  return true;
}

/** Precedence: explicit environment > explicitly opted-in project > private profile > legacy CLI .env. */
export function loadBabelCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath?: string,
): {
  envFilePath: string;
  envFileExists: boolean;
  loaded: boolean;
} {
  const privatePath = envFilePath ?? resolvePrivateCredentialEnvPath(env);
  if (envFilePath === undefined) loadOptedInProjectCredentials(env);
  const files = envFilePath !== undefined ? [envFilePath] : [
    privatePath,
    ...(resolveRuntimePaths(env).isInstalled ? [] : [resolve(BABEL_CLI_PACKAGE_ROOT, '.env')]),
  ];
  let loaded = false;
  let found = false;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Credential configuration must be a regular file');
    }
    if (file === privatePath && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error('Private credential file permissions are too broad');
    }
    found = true;
    const result = dotenvConfig({
      path: file,
      override: false,
      debug: false,
      quiet: true,
      processEnv: env,
    });
    if (result.error) throw new Error('Could not load credential configuration');
    loaded = true;
  }
  envFileLoadAttempted = true;
  envFileLoaded = loaded;
  return { envFilePath: privatePath, envFileExists: found, loaded };
}

/** Keys declared in babel-cli/.env that are not active in the current process environment. */
export function getEnvFileKeysNotActiveInProcess(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = resolvePrivateCredentialEnvPath(env),
): string[] {
  if (!existsSync(envFilePath)) {
    return [];
  }

  return parseEnvFileKeys(envFilePath).filter((key) => !isEnvValueActive(key, env));
}

export function wasBabelCliEnvFileLoaded(): boolean {
  return envFileLoaded;
}

export function wasBabelCliEnvFileLoadAttempted(): boolean {
  return envFileLoadAttempted;
}

export function isStrictEnvMode(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    argv.includes('--strict-env') ||
    (Object.prototype.hasOwnProperty.call(env, 'BABEL_STRICT_ENV') &&
      envTruthy(env['BABEL_STRICT_ENV'])) ||
    (Object.prototype.hasOwnProperty.call(env, 'CI') && envTruthy(env['CI']))
  );
}

function envTruthy(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function formatEnvFileInactiveMessage(missingKeys: string[], envFilePath: string): string {
  const preview = missingKeys.slice(0, 8).join(', ');
  const suffix = missingKeys.length > 8 ? ` (+${missingKeys.length - 8} more)` : '';
  return [
    `Babel credential .env exists at "${envFilePath}" but ${missingKeys.length} variable(s) from that file are not active in this process: ${preview}${suffix}.`,
    'Env-gated CLI features may be silently disabled.',
    'Canonical invocations:',
    '  Babel normally loads the private profile .env automatically.',
    '  babel <command>   (after npm --prefix ./babel-cli run build)',
    '  npm --prefix ./babel-cli run dev -- <command>',
    'Use --strict-env (or set BABEL_STRICT_ENV=true / CI=true) to fail instead of warn.',
  ].join('\n');
}

export type EnvBootstrapCommandOptions = {
  json?: boolean;
  strict?: boolean;
};

/**
 * Warn or exit when babel-cli/.env defines variables that are not active after bootstrap.
 * Intended for pipeline entry commands (`run`, `plan`, `resolve`).
 */
export function assertEnvFileActiveForPipelineCommand(
  options: EnvBootstrapCommandOptions = {},
): void {
  const missingKeys = getEnvFileKeysNotActiveInProcess();
  if (missingKeys.length === 0) {
    return;
  }

  const strict = options.strict === true || isStrictEnvMode();
  const message = formatEnvFileInactiveMessage(missingKeys, BABEL_CLI_ENV_FILE_PATH);

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'fail',
          error: message,
          missing_env_keys: missingKeys,
          env_file: BABEL_CLI_ENV_FILE_PATH,
          env_file_loaded: wasBabelCliEnvFileLoaded(),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    console.error(`[babel] ${message}`);
  }

  if (strict) {
    process.exit(1);
  }
}

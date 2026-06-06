import { config as dotenvConfig, parse as dotenvParse } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the babel-cli package root (directory containing package.json and .env). */
export const BABEL_CLI_PACKAGE_ROOT = resolve(__dirname, '../..');

export const BABEL_CLI_ENV_FILE_PATH = resolve(BABEL_CLI_PACKAGE_ROOT, '.env');

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

/** Load babel-cli/.env without overriding variables already set in the process environment. */
export function loadBabelCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = BABEL_CLI_ENV_FILE_PATH,
): {
  envFilePath: string;
  envFileExists: boolean;
  loaded: boolean;
} {
  const envFileExists = existsSync(envFilePath);

  if (!envFileExists) {
    envFileLoadAttempted = true;
    envFileLoaded = false;
    return { envFilePath, envFileExists, loaded: false };
  }

  const result = dotenvConfig({
    path: envFilePath,
    override: false,
    debug: false,
    quiet: true,
    processEnv: env,
  });

  envFileLoadAttempted = true;
  envFileLoaded = !result.error;
  return { envFilePath, envFileExists, loaded: envFileLoaded };
}

/** Keys declared in babel-cli/.env that are not active in the current process environment. */
export function getEnvFileKeysNotActiveInProcess(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = BABEL_CLI_ENV_FILE_PATH,
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

export function isStrictEnvMode(argv: string[] = process.argv): boolean {
  return (
    argv.includes('--strict-env') ||
    envTruthy(process.env['BABEL_STRICT_ENV']) ||
    envTruthy(process.env['CI'])
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
    `babel-cli/.env exists at "${envFilePath}" but ${missingKeys.length} variable(s) from that file are not active in this process: ${preview}${suffix}.`,
    'Env-gated CLI features may be silently disabled.',
    'Canonical invocations:',
    '  node --env-file=./babel-cli/.env ./babel-cli/dist/index.js <command>',
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
    process.stdout.write(`${JSON.stringify({
      status: 'fail',
      error: message,
      missing_env_keys: missingKeys,
      env_file: BABEL_CLI_ENV_FILE_PATH,
      env_file_loaded: wasBabelCliEnvFileLoaded(),
    }, null, 2)}\n`);
  } else {
    console.error(`[babel] ${message}`);
  }

  if (strict) {
    process.exit(1);
  }
}

loadBabelCliEnv();

/**
 * Shared-protocol test shim import helpers.
 * Generated static ESM must use file: URL specifiers on all platforms; native paths
 * are reserved for dist/argv/receipt/cwd only.
 */
import { fileURLToPath } from 'node:url';

export const STARTUP_ERROR_CODE_ALLOWLIST = Object.freeze([
  'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
]);

/** file: href for desktop-cli-shim-runtime.mjs (safe static import specifier). */
export function desktopCliShimRuntimeImportHref() {
  return new URL('./desktop-cli-shim-runtime.mjs', import.meta.url).href;
}

/**
 * @param {{
 *   distPath: string;
 *   receiptPath: string;
 *   shimOptions?: Record<string, string | boolean | number>;
 * }} options native filesystem paths for dist/receipt; optional extra shim fields
 */
export function buildDesktopCliShimEntrySource({ distPath, receiptPath, shimOptions = {} }) {
  const runtimeHref = desktopCliShimRuntimeImportHref();
  if (!runtimeHref.startsWith('file:')) {
    throw new Error('desktopCliShimRuntime import href must be a file: URL');
  }
  const extraFields = Object.entries(shimOptions)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
    .join('\n');
  return `import { runDesktopCliShim } from ${JSON.stringify(runtimeHref)};
runDesktopCliShim({
  dist: ${JSON.stringify(distPath)},
  argv: process.argv.slice(2),
  hostRunReceipt: ${JSON.stringify(receiptPath)},
${extraFields}
});
`;
}

/** Match only allowlisted Node/system codes observed in test harness stderr (no raw forward). */
export function classifyAllowlistedStartupCodes(observedUtf8) {
  const text = typeof observedUtf8 === 'string' ? observedUtf8 : observedUtf8.toString('utf8');
  return STARTUP_ERROR_CODE_ALLOWLIST.filter((code) => text.includes(code));
}

/**
 * Windows-shaped drive-letter path used by the pre-fix fixture (negative regression aid).
 * On non-Windows hosts uses a representative `D:\...` path; Node rejects `D:` as a URL scheme
 * before loading regardless of whether the target file exists.
 */
export function windowsShapedDriveLetterImportSpecifier(
  runtimeUrl = new URL('./desktop-cli-shim-runtime.mjs', import.meta.url),
) {
  if (process.platform === 'win32') {
    return fileURLToPath(runtimeUrl);
  }
  return 'D:\\a\\Babel\\Babel\\babel-desktop\\test\\desktop-cli-shim-runtime.mjs';
}

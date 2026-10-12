// License: Apache-2.0
// Packaged-app import guard: every relative ESM import inside resources/app
// must resolve to a file that was actually copied into the bundle. This is the
// check that catches an allowlist gap like native/ importing ../src/core.mjs
// without src/ being packaged — the failure mode that made packaged installs
// crash at launch while source checkouts worked.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ESM_EXTENSION_RE = /\.(mjs|cjs|js)(?:\?[^'"#]*)?(?:#.*)?$/i;

function* walk(dir) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && /\.mjs$/i.test(entry.name)) yield full;
  }
}

function relativeSpecifiers(source) {
  const specs = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) specs.push(match[1]);
  return specs;
}

function pathExistsAsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathExistsAsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isInsideAppRoot(resolvedPath, appDir) {
  const root = resolve(appDir);
  const candidate = resolve(resolvedPath);
  if (candidate === root) return true;
  return candidate.startsWith(root + sep);
}

/**
 * Resolve a relative import specifier from a packaged module file.
 * @returns {string | null} absolute filesystem path, or null when the URL is not a file:
 */
function resolveRelativeTarget(file, spec) {
  const url = new URL(spec, pathToFileURL(file));
  if (url.protocol !== 'file:') return null;
  return fileURLToPath(url);
}

/**
 * @param {string} file
 * @param {string} spec
 * @param {string} appDir
 * @returns {{file: string, spec: string, target: string, reason: string} | null}
 */
function classifyRelativeImport(file, spec, appDir) {
  let target;
  try {
    target = resolveRelativeTarget(file, spec);
  } catch {
    return {file, spec, target: spec, reason: 'invalid-specifier'};
  }
  if (target === null) return null;

  if (!isInsideAppRoot(target, appDir)) {
    return {file, spec, target, reason: 'outside-app-root'};
  }

  const trailingSlash = spec.endsWith('/');
  if (trailingSlash || pathExistsAsDirectory(target)) {
    return {file, spec, target, reason: 'directory-import'};
  }

  if (!ESM_EXTENSION_RE.test(spec)) {
    return {file, spec, target, reason: 'extensionless-import'};
  }

  if (pathExistsAsFile(target)) return null;
  return {file, spec, target, reason: 'missing-module'};
}

/**
 * Scan every .mjs file under appDir for relative imports and return the ones
 * whose target file is missing from the bundle. Directory imports (no
 * extension) are reported too — packaged ESM needs explicit file extensions.
 * @param {string} appDir packaged resources/app root
 * @returns {Array<{file: string, spec: string, target: string, reason?: string}>}
 */
export function findUnresolvedRelativeImports(appDir) {
  const unresolved = [];
  const appRoot = resolve(appDir);
  for (const file of walk(appRoot)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      unresolved.push({file, spec: '<unreadable>', target: String(error.message), reason: 'unreadable'});
      continue;
    }
    for (const spec of relativeSpecifiers(source)) {
      const issue = classifyRelativeImport(file, spec, appRoot);
      if (issue) unresolved.push(issue);
    }
  }
  return unresolved;
}

/**
 * Throw when the packaged app contains relative imports that will not resolve.
 * @param {string} appDir packaged resources/app root
 */
export function assertAppImportsResolve(appDir) {
  const unresolved = findUnresolvedRelativeImports(appDir);
  if (unresolved.length) {
    const shown = unresolved.slice(0, 10).map(u => `  ${u.file}: '${u.spec}' -> ${u.target} (${u.reason ?? 'unresolved'})`).join('\n');
    throw new Error(`Packaged app has ${unresolved.length} unresolved relative import(s); the bundle would crash at launch:\n${shown}`);
  }
}

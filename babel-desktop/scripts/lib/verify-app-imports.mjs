// License: Apache-2.0
// Packaged-app import guard: every relative ESM import inside resources/app
// must resolve to a file that was actually copied into the bundle. This is the
// check that catches an allowlist gap like native/ importing ../src/core.mjs
// without src/ being packaged — the failure mode that made packaged installs
// crash at launch while source checkouts worked.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

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

function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function importTarget(file, spec) {
  // new URL(spec, base) normalizes '.'/'..' segments; pathname of a file URL
  // on Windows is /C:/... so strip the leading slash and restore separators.
  const url = new URL(spec, pathToFileURL(file));
  if (url.protocol !== 'file:') return null;
  return decodeURIComponent(url.pathname).slice(1).replace(/\//g, sep);
}

/**
 * Scan every .mjs file under appDir for relative imports and return the ones
 * whose target file is missing from the bundle. Directory imports (no
 * extension) are reported too — packaged ESM needs explicit file extensions.
 * @param {string} appDir packaged resources/app root
 * @returns {Array<{file: string, spec: string, target: string}>}
 */
export function findUnresolvedRelativeImports(appDir) {
  const unresolved = [];
  for (const file of walk(appDir)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      unresolved.push({file, spec: '<unreadable>', target: String(error.message)});
      continue;
    }
    for (const spec of relativeSpecifiers(source)) {
      const target = importTarget(file, spec);
      if (target === null) continue;
      if (fileExists(target)) continue;
      if (!/\.[cm]?js$/i.test(spec) && fileExists(`${target}.mjs`)) continue;
      unresolved.push({file, spec, target});
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
    const shown = unresolved.slice(0, 10).map(u => `  ${u.file}: '${u.spec}' -> ${u.target}`).join('\n');
    throw new Error(`Packaged app has ${unresolved.length} unresolved relative import(s); the bundle would crash at launch:\n${shown}`);
  }
}

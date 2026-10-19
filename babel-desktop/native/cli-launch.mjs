/** Node flags required before the Babel CLI entry (matches bin/babel.js qualification). */
export const BABEL_NODE_WASM_ARGS = Object.freeze(['--experimental-wasm-modules']);

/** argv for `spawn(executable, productionNodeCliArgv(entry, cliArgs))`. */
export function productionNodeCliArgv(entry, cliArgs) {
  if (typeof entry !== 'string' || !entry) throw new TypeError('CLI entry path is required');
  return [...BABEL_NODE_WASM_ARGS, entry, ...(cliArgs ?? [])];
}

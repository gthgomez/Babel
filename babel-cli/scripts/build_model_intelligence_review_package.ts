/**
 * Compatibility entrypoint for the final package builder.
 *
 * The package is deliberately emitted outside the repository and is validated
 * semantically before ZIP creation and again after extraction. Use the root
 * tool directly when supplying the final evidence roots.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const builder = fileURLToPath(new URL('../../tools/build-final-recertification-package.mjs', import.meta.url));
const args = process.argv.slice(2);
if (!args.includes('--repo')) args.push('--repo', '..');
const result = spawnSync(process.execPath, [builder, ...args], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');
const distDir = resolve(packageRoot, 'dist');

rmSync(distDir, { recursive: true, force: true });
// Remove the incremental build cache so tsc always re-emits after a clean.
const tsBuildInfoFile = resolve(packageRoot, '.tsbuildinfo');
try { rmSync(tsBuildInfoFile, { force: true }); } catch { /* ok if missing */ }

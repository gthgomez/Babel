/**
 * Copy playbook JSON assets into dist so production `node dist/` loads them
 * beside the compiled playbookService.js (belt-and-suspenders with src fallback).
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const srcDir = resolve(packageRoot, 'src', 'services', 'playbooks');
const distDir = resolve(packageRoot, 'dist', 'services', 'playbooks');

if (!existsSync(srcDir)) {
  console.error(`copy_playbooks: source missing: ${srcDir}`);
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
cpSync(srcDir, distDir, {
  recursive: true,
  filter: (src) => {
    // Copy only .json playbook definitions (skip tests / .ts)
    if (src === srcDir) return true;
    return src.endsWith('.json');
  },
});
console.log(`copy_playbooks: copied *.json → ${distDir}`);

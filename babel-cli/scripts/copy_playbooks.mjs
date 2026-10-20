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

// Carry the owned data-only native oracle with the compiled CLI. This is an
// asset copy, not runtime selection or trusted-verifier activation: callers
// must still qualify and freeze their complete host/compiler dependency closure.
const oracleSource = resolve(packageRoot, 'src', 'authority', 'ownedFileAssertion.windows.ps1');
const oracleDestination = resolve(packageRoot, 'dist', 'authority', 'ownedFileAssertion.windows.ps1');
mkdirSync(dirname(oracleDestination), { recursive: true });
cpSync(oracleSource, oracleDestination);
console.log('copy_playbooks: copied owned native oracle asset');

const openCodePinSource = resolve(packageRoot, 'src', 'bridge', 'opencode-acp-source-pin.json');
const openCodePinDestination = resolve(packageRoot, 'dist', 'bridge', 'opencode-acp-source-pin.json');
if (!existsSync(openCodePinSource)) {
  console.error(`copy_playbooks: OpenCode source pin missing: ${openCodePinSource}`);
  process.exit(1);
}
mkdirSync(dirname(openCodePinDestination), { recursive: true });
cpSync(openCodePinSource, openCodePinDestination);
console.log(`copy_playbooks: copied OpenCode ACP source pin → ${openCodePinDestination}`);

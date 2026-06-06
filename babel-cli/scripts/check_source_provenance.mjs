import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');
const srcRoot = resolve(packageRoot, 'src');
const provenancePath = resolve(packageRoot, 'source-provenance.json');

function walkJsFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(relative(packageRoot, fullPath).replace(/\\/g, '/'));
    }
  }
}

const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
const allowed = new Set(
  Array.isArray(provenance.allowed_js_source_files)
    ? provenance.allowed_js_source_files
    : [],
);

const actual = [];
walkJsFiles(srcRoot, actual);
actual.sort();

const unexpected = actual.filter(file => !allowed.has(file));
const missing = [...allowed].filter(file => !actual.includes(file)).sort();

if (unexpected.length > 0 || missing.length > 0) {
  console.error('[babel] Source provenance check failed.');
  if (unexpected.length > 0) {
    console.error('[babel] Unexpected JS source files:');
    for (const file of unexpected) console.error(`  ${file}`);
  }
  if (missing.length > 0) {
    console.error('[babel] Listed JS provenance files not found:');
    for (const file of missing) console.error(`  ${file}`);
  }
  process.exit(1);
}

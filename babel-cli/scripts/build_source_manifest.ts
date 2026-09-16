import { buildByteAttestedSourceManifest, type SourceManifestFileKind } from '../src/services/sourceManifest.js';

const args = process.argv.slice(2);
let root: string | undefined;
let kind: SourceManifestFileKind = 'tracked';
const files: Array<{ path: string; kind: SourceManifestFileKind }> = [];

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--root') {
    root = args[++index];
  } else if (arg === '--kind') {
    const value = args[++index] as SourceManifestFileKind | undefined;
    if (value !== 'tracked' && value !== 'untracked' && value !== 'supplement') {
      throw new Error('--kind must be tracked, untracked, or supplement');
    }
    kind = value;
  } else if (arg === '--file') {
    const file = args[++index];
    if (!file) throw new Error('--file requires a relative path');
    files.push({ path: file, kind });
  } else {
    throw new Error(`unknown argument: ${arg}`);
  }
}

if (!root) throw new Error('--root is required');
if (files.length === 0) throw new Error('at least one --file is required');

process.stdout.write(
  JSON.stringify(buildByteAttestedSourceManifest({ root, files }), null, 2) + '\n',
);

// License: Apache-2.0
import {spawn} from 'node:child_process';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundledEnvironment} from '../app/native/runtime.mjs';
import {resolvePackagedEngine} from '../app/native/engine-manager.mjs';
import {applyProviderRoute} from '../app/native/provider-routing.mjs';

const runtime = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const profileArg = args.findIndex(arg => arg.startsWith('--profile-dir='));
const profile = profileArg < 0 ? join(process.env.APPDATA || process.env.USERPROFILE, 'babel-north-star-desktop') : args.splice(profileArg, 1)[0].slice('--profile-dir='.length);
if (!isAbsolute(profile)) throw new Error('--profile-dir must be an absolute directory');

const bundledEntry = join(runtime, 'cli', 'dist', 'index.js');
const nodeExe = join(runtime, 'node', 'node.exe');
const resourcesPath = dirname(runtime);
const bundled = {
  path: bundledEntry,
  label: 'Bundled Babel CLI',
  executable: nodeExe,
  source: 'bundled',
  ready: true,
};

let entryPath = bundledEntry;
try {
  const resolved = resolvePackagedEngine({userData: profile, resourcesPath, bundled});
  if (resolved?.ready && resolved?.path) {
    entryPath = resolved.path;
  }
} catch {
  entryPath = bundledEntry;
}

const env=bundledEnvironment(profile);
applyProviderRoute(env,env.BABEL_CONFIG_DIR);
const child = spawn(nodeExe, [entryPath, ...args], {env, stdio: 'inherit', windowsHide: true, shell: false});
child.on('error', error => { console.error(`Babel CLI could not start: ${error.message}`); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });

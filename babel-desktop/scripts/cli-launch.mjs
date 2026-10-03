// License: Apache-2.0
import {spawn} from 'node:child_process';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundledEnvironment} from '../app/native/runtime.mjs';
const runtime = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const profileArg = args.findIndex(arg => arg.startsWith('--profile-dir='));
const profile = profileArg < 0 ? join(process.env.APPDATA || process.env.USERPROFILE, 'babel-north-star-desktop') : args.splice(profileArg,1)[0].slice('--profile-dir='.length);
if(!isAbsolute(profile)) throw new Error('--profile-dir must be an absolute directory');
const child = spawn(join(runtime,'node','node.exe'),[join(runtime,'cli','dist','index.js'),...args],{env:bundledEnvironment(profile),stdio:'inherit',windowsHide:true,shell:false});
child.on('error',error=>{console.error(`Bundled CLI could not start: ${error.message}`);process.exitCode=1;});
child.on('close',code=>{process.exitCode=code ?? 1;});

// Desktop packaging omits optional dependencies; install the pinned Linux
// Secret Service binding explicitly and keep its third-party license notice.
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

export function installLinuxKeyringBinding({cwd,npmCli,nodeExec=process.execPath,platform=process.platform,arch=process.arch,execute=execFileSync}){
  if(platform!=='linux'||arch!=='x64')throw new Error('The Desktop Linux package requires the linux-x64 keyring binding.');
  const name='@napi-rs/keyring-linux-x64-gnu',version='2.1.2';
  const root=join(cwd,'node_modules','@napi-rs','keyring-linux-x64-gnu');
  if(!existsSync(join(root,'package.json')))execute(nodeExec,[npmCli,'install',`${name}@${version}`,'--omit=dev','--no-save','--ignore-scripts','--no-audit','--no-fund'],{cwd,stdio:'inherit',windowsHide:true});
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(manifest.name!==name||manifest.version!==version||!existsSync(join(root,'LICENSE.third-party.md')))throw new Error('The pinned Linux keyring binding or its third-party notices are missing.');
  // Loading the addon checks the binary but does not open a credential store.
  const keyring=createRequire(join(cwd,'package.json'))('@napi-rs/keyring');
  if(typeof keyring.Entry!=='function')throw new Error('The Linux keyring binding could not load.');
  return name;
}

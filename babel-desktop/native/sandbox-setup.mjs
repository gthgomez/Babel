// License: Apache-2.0
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';

// Docker Official Node image, linux/amd64 manifest observed 2026-10-14.
// Pin content rather than silently following a mutable tag at preparation time.
export const RECOMMENDED_IMAGE='docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0';
const executeFile=promisify(execFile);
export const isPinnedImage=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);

export function validateSandboxImageReference(value){
  if(typeof value!=='string'||value.length>512||!value.length||value.includes('://')||! /^[a-z0-9][a-z0-9._/:@-]*$/i.test(value)){
    throw new Error('Enter a Docker image reference without spaces, options or shell syntax.');
  }
  return value;
}

/** Non-secret profile settings only; the exact inspected local image wins. */
export function applySandboxEnvironment(env,preferences={}){
  if(isPinnedImage(preferences.sandboxImage))env.BABEL_BENCHMARK_DOCKER_IMAGE=preferences.sandboxImage;
  return env;
}

function dockerEnvironment(){
  const env={};
  for(const name of ['PATH','SystemRoot','WINDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']){
    if(process.env[name]!==undefined)env[name]=process.env[name];
  }
  return env;
}

/** Explicit preparation never runs project code, mounts files, or enables host fallback. */
export async function configureSandboxImage({reference,prepareRecommended=false,execute=executeFile}={}){
  if(typeof prepareRecommended!=='boolean')throw new Error('Invalid sandbox preparation request.');
  const image=validateSandboxImageReference(prepareRecommended?RECOMMENDED_IMAGE:reference);
  const run=(args,timeout)=>execute('docker',args,{shell:false,windowsHide:true,timeout,maxBuffer:256*1024,env:dockerEnvironment()});
  if(prepareRecommended){
    try{await run(['pull','--platform=linux/amd64',RECOMMENDED_IMAGE],300000);}
    catch{throw new Error('Sandbox download failed or timed out. Start Docker Desktop with Linux containers, then retry preparation.');}
  }
  let record;
  try{
    const result=await run(['image','inspect','--format','{{json .}}','--',image],5000);
    record=JSON.parse(result.stdout);
  }catch{throw new Error('Sandbox image is not available locally. Start Docker Desktop, then prepare the recommended image or select an existing image.');}
  if(record?.Os!=='linux'||record?.Architecture!=='amd64'||!isPinnedImage(record?.Id)){
    throw new Error('Choose a Linux amd64 Docker image for this Windows x64 application.');
  }
  const probe=prepareRecommended
    ? 'git --version >/dev/null && node --version >/dev/null && npm --version >/dev/null'
    : 'git --version >/dev/null';
  const containerName=`babel-setup-${randomUUID()}`;
  try{
    await run(['run','--rm',`--name=${containerName}`,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
      '--pids-limit=64','--memory=256m','--cpus=1','--user=65534:65534','--tmpfs=/tmp:rw,nosuid,size=32m',
      '--env=HOME=/tmp','--env=NPM_CONFIG_UPDATE_NOTIFIER=false','--entrypoint=/bin/sh',record.Id,'-c',probe],10000);
  }catch{throw new Error(prepareRecommended?'Sandbox tool verification failed. The recommended image must run shell, Git, Node and npm.':'Sandbox tool verification failed. The image must run /bin/sh and Git; include the tools your project tests require.');}
  finally{
    // Killing a timed-out Docker client does not stop its container. Remove only
    // this probe's random, application-owned name; --rm may already have done so.
    try{await run(['rm','--force',containerName],5000);}catch{}
  }
  return {sandboxImage:record.Id,sandboxImageReference:image};
}

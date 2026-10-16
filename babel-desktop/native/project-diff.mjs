import {execFile} from 'node:child_process';
import {lstat,realpath,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readProjectFile,resolveScoped} from './workspace.mjs';

const MAX_DIFF_BYTES=1024*1024;
function git(root,args,{isolated=false,binary=false}={}){
  const env={...process.env};
  for(const name of Object.keys(env))if(/^GIT_/i.test(name))delete env[name];
  Object.assign(env,{GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
  if(isolated)env.GIT_CEILING_DIRECTORIES=path.dirname(root);
  return new Promise((resolve,reject)=>execFile('git',['--no-pager','--literal-pathspecs','-c','core.fsmonitor=false','-C',root,...args],{
    shell:false,windowsHide:true,timeout:10000,maxBuffer:MAX_DIFF_BYTES,encoding:binary?'buffer':'utf8',env,
  },(error,stdout)=>{
    if(error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return resolve({code:0,text:stdout,truncated:true});
    if(error&&(!Number.isInteger(error.code)||error.killed))return reject(new Error('Git diff could not finish. Check Git availability and retry.'));
    resolve({code:error?.code??0,text:stdout,truncated:false});
  }));
}

/** Compare raw, bounded snapshots outside repository configuration; never run working-tree filters. */
export async function readProjectDiff(root,relative,{cacheDirectory=path.join(tmpdir(),'babel-desktop-diff-cache')}={}){
  const target=await resolveScoped(root,relative,{allowMissing:true});
  const base=await realpath(root);
  const scoped=path.relative(base,target).replace(/\\/g,'/');
  let exists=true;
  try{if(!(await lstat(target)).isFile())throw new Error('Only regular project files have a text diff');}
  catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
  const repository=await git(base,['rev-parse','--show-toplevel']);
  if(repository.code!==0)throw new Error('The selected project is not an available Git checkout');
  const repositoryRoot=await realpath(repository.text.trim());
  const relativeRoot=path.relative(repositoryRoot,base);
  if(relativeRoot==='..'||relativeRoot.startsWith(`..${path.sep}`)||path.isAbsolute(relativeRoot))throw new Error('Git working tree is outside the selected project scope');
  const head=await git(base,['rev-parse','--verify','HEAD']);
  const baseRevision=head.code===0&&/^[a-f0-9]{40,64}$/.test(head.text.trim())?head.text.trim():null;
  const treePath=path.relative(repositoryRoot,target).replace(/\\/g,'/');
  let before='',hasBaseline=false,truncated=false,validBaselineUtf8=true;
  if(baseRevision){
    const listing=await git(repositoryRoot,['ls-tree','-z','--full-tree',baseRevision,'--',treePath]);
    if(listing.code!==0||listing.truncated)throw new Error('Git baseline file identity is unavailable');
    const entry=listing.text.split('\0').filter(Boolean).map(line=>/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64})\t([\s\S]*)$/.exec(line)).find(record=>record?.[4]===treePath);
    if(entry&&entry[2]!=='blob')throw new Error('This baseline path is a directory or repository link; choose an individual permitted file');
    if(entry){
      const blob=await git(base,['cat-file','blob',entry[3]],{binary:true});
      if(blob.code!==0)throw new Error('Git baseline content is unavailable');
      const bytes=blob.text,preview=bytes.subarray(0,256*1024);
      before=preview.toString('utf8');
      validBaselineUtf8=Buffer.from(before,'utf8').equals(preview);
      hasBaseline=true;truncated=blob.truncated||bytes.length>256*1024;
    }
  }
  if(!exists&&!hasBaseline)throw new Error('This file is unavailable in the working tree and Git baseline');
  const current=exists?await readProjectFile(base,scoped):{text:'',truncated:false};
  truncated||=current.truncated;
  const kind=!exists?'deleted':hasBaseline?'tracked':'added';
  let diff='';
  const binary=!validBaselineUtf8||current.validUtf8===false||before.includes('\0')||current.text.includes('\0');
  if(binary)diff='Binary or unsupported text encoding is not displayed; changes are not established by this text view.';
  else{
    await mkdir(cacheDirectory,{recursive:true,mode:0o700});
    const cacheRoot=await realpath(cacheDirectory);
    const temporary=await mkdtemp(path.join(cacheRoot,'diff-'));
    try{
      await writeFile(path.join(temporary,'before'),before,{mode:0o600,flag:'wx'});
      await writeFile(path.join(temporary,'after'),current.text,{mode:0o600,flag:'wx'});
      const result=await git(temporary,['diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--no-renames','--unified=3','--','before','after'],{isolated:true});
      if(result.code!==0&&result.code!==1)throw new Error('Git could not compare the file snapshots');
      truncated||=result.truncated;
      const a=JSON.stringify(`a/${scoped}`),b=JSON.stringify(`b/${scoped}`);
      diff=result.text.replace(/^diff --git a\/before b\/after$/m,()=>`diff --git ${a} ${b}`).replace(/^--- a\/before$/m,()=>hasBaseline?`--- ${a}`:'--- /dev/null').replace(/^\+\+\+ b\/after$/m,()=>exists?`+++ ${b}`:'+++ /dev/null');
      if(!diff&&(!hasBaseline||!exists))diff=`${exists?'new':'deleted'} file: ${JSON.stringify(scoped)}\n`;
    }finally{
      if(path.dirname(temporary)!==cacheRoot||path.dirname(await realpath(temporary))!==cacheRoot)throw new Error('Diff cache cleanup escaped its owned directory');
      await rm(temporary,{recursive:true,force:true});
    }
  }
  if(Buffer.byteLength(diff)>MAX_DIFF_BYTES){
    diff=Buffer.from(diff).subarray(0,MAX_DIFF_BYTES).toString('utf8');
    while(Buffer.byteLength(diff)>MAX_DIFF_BYTES)diff=diff.slice(0,-1);
    truncated=true;
  }
  await resolveScoped(base,relative,{allowMissing:true});
  return {path:scoped,diff,kind,baseRevision,truncated,binary,hasChanges:binary?null:diff?true:truncated?null:false,capturedAt:new Date().toISOString(),comparison:'raw-file-snapshots'};
}

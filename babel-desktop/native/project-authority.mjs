import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,realpath,open,mkdir,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve,relative,sep} from 'node:path';

const exec=promisify(execFile);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameIdentity=(a,b)=>a?.id===b?.id&&a?.root===b?.root;
const rootKey=root=>typeof root==='string'?(process.platform==='win32'?resolve(root).toLowerCase():resolve(root)):null;

async function directoryIdentity(path){
  const canonical=await realpath(path), info=await lstat(canonical,{bigint:true});
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Project identity is not a regular directory.');
  return {path:canonical,device:String(info.dev),inode:String(info.ino),createdNs:String(info.birthtimeNs)};
}
function gitEnvironment(){
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name)));
  return {...env,LC_ALL:'C',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'};
}
async function git(root,args){
  return exec('git',['-c','core.fsmonitor=false','-C',root,...args],{env:gitEnvironment(),windowsHide:true,timeout:3000,maxBuffer:16384,encoding:'utf8'});
}

/** Observe directory and Git ownership independently of branch/HEAD movement. */
export async function inspectProjectIdentity(root){
  if(typeof root!=='string'||!isAbsolute(root)||root.includes('\0'))throw new Error('Select an absolute project directory.');
  const directory=await directoryIdentity(root);
  if(rootKey(root)!==rootKey(directory.path))throw new Error('Selected project path changed physical identity. Select the canonical project again.');
  let repository=null,branch=null,head=null;
  try{
    const result=await git(directory.path,['rev-parse','--path-format=absolute','--show-toplevel','--absolute-git-dir','--git-common-dir']);
    const paths=result.stdout.trimEnd().split(/\r?\n/);
    if(paths.length!==3||paths.some(value=>!isAbsolute(value)))throw new Error('Ambiguous Git directory identity.');
    repository={root:await directoryIdentity(paths[0]),git:await directoryIdentity(paths[1]),common:await directoryIdentity(paths[2])};
    const relation=relative(repository.root.path,directory.path);
    if(relation==='..'||relation.startsWith(`..${sep}`)||isAbsolute(relation))throw new Error('Git working tree is outside the selected project binding.');
  }catch(error){
    if(!/^fatal: not a git repository/i.test(error.stderr??''))throw new Error('Project repository identity could not be verified.');
  }
  if(repository){
    try{branch=(await git(directory.path,['symbolic-ref','--short','-q','HEAD'])).stdout.trim()||null;}catch(error){if(error.code!==1)throw new Error('Project branch could not be verified.');}
    try{head=(await git(directory.path,['rev-parse','--verify','--quiet','HEAD'])).stdout.trim()||null;}catch(error){if(error.code!==1)throw new Error('Project revision could not be verified.');}
  }
  const identity={root:directory.path,directory,repository};
  return {...identity,id:digest(identity),branch,head};
}

/** Single Electron owner, versioned non-secret grants; never infer trust from selection. */
export class ProjectAuthority {
  #state={schemaVersion:1,revision:0,grants:[]};
  #epoch=0;
  #queue=Promise.resolve();
  #readOnly=false;
  #fenced=new Set();
  constructor(file){this.file=file;}
  get generation(){return this.#epoch;}
  static async open(file){
    const authority=new ProjectAuthority(file);
    try{
      const handle=await open(file,'r');
      try{
        const info=await handle.stat();
        if(!info.isFile()||info.size>65536)throw new Error('Invalid authority file.');
        const bytes=Buffer.alloc(info.size+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
        if(bytesRead>info.size)throw new Error('Authority file changed.');
        const state=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
        if(state.schemaVersion!==1||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.grants)||state.grants.length>100||state.grants.some(grant=>!grant.identity?.id||!isAbsolute(grant.identity.root)||!Number.isSafeInteger(grant.revision)))throw new Error('Unsupported authority schema.');
        authority.#state=state;
      }finally{await handle.close();}
    }catch(error){if(error.code!=='ENOENT')authority.#readOnly=true;}
    return authority;
  }
  #serialize(work){
    const result=this.#queue.then(work);
    this.#queue=result.catch(()=>{});
    return result;
  }
  async #persist(state){
    if(this.#readOnly)throw new Error('Project authority schema is unavailable or read-only.');
    if(state.grants.length>100||Buffer.byteLength(JSON.stringify(state))>65536)throw new Error('Project authority storage is full.');
    await mkdir(dirname(this.file),{recursive:true});
    const temporary=join(dirname(this.file),`.authority-${randomUUID()}.next`);
    try{
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}
      await rename(temporary,this.file);
      this.#state=state;
    }finally{await rm(temporary,{force:true});}
  }
  async inspect(root){
    if(!root)return {scope:'conversation',trusted:false,identity:null,revision:this.#state.revision,readOnly:this.#readOnly};
    const identity=await inspectProjectIdentity(root);
    const grant=this.#state.grants.find(item=>sameIdentity(item.identity,identity));
    return {scope:'project',trusted:!this.#readOnly&&!this.#fenced.has(rootKey(identity.root))&&Boolean(grant),identity,revision:grant?.revision??this.#state.revision,readOnly:this.#readOnly};
  }
  grant(root,confirmedIdentity,epoch=this.#epoch){
    return this.#serialize(async()=>{
      if(this.#readOnly)throw new Error('Project authority schema is unavailable or read-only.');
      const identity=await inspectProjectIdentity(root);
      if(epoch!==this.#epoch||!sameIdentity(identity,confirmedIdentity))throw new Error('Project identity or authority changed while confirming trust.');
      const revision=this.#state.revision+1;
      await this.#persist({...this.#state,revision,grants:[...this.#state.grants.filter(item=>rootKey(item.identity.root)!==rootKey(identity.root)),{identity,revision,grantedAt:new Date().toISOString()}]});
      // A concurrent revoke fences immediately and queues a durable removal.
      if(epoch===this.#epoch)this.#fenced.delete(rootKey(identity.root));
      return this.inspect(root);
    });
  }
  revoke(root){
    this.#epoch++;
    this.#fenced.add(rootKey(root));
    return this.#serialize(async()=>{
      await this.#persist({...this.#state,revision:this.#state.revision+1,grants:this.#state.grants.filter(item=>rootKey(item.identity.root)!==rootKey(root))});
      return {revoked:true};
    });
  }
  async admit(root){
    const epoch=this.#epoch,scope=await this.inspect(root);
    if(epoch!==this.#epoch||!scope.trusted)throw new Error('Trust this exact project before granting access.');
    return {...scope,epoch};
  }
  isCurrent(admission){
    return !this.#readOnly&&admission?.epoch===this.#epoch&&!this.#fenced.has(rootKey(admission?.identity?.root))&&this.#state.grants.some(grant=>sameIdentity(grant.identity,admission?.identity)&&grant.revision===admission?.revision);
  }
}

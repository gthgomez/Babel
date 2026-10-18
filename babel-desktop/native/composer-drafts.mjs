import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,realpath,rename,rm} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';

const MAX_BYTES=8*1024*1024;
const ID=/^[\w-]{1,100}$/;
const SESSION_ID=/^[\w-]{1,80}$/;
const SCOPE=/^[a-f0-9]{64}$/;

/** UI data binding only. This key confers no project or tool authority. */
export function composerDraftScope(projectRoot){
  if(projectRoot!==null&&(typeof projectRoot!=='string'||!isAbsolute(projectRoot)))throw new Error('Invalid draft project binding');
  const root=projectRoot===null?null:resolve(projectRoot);
  return createHash('sha256').update(JSON.stringify({projectRoot:process.platform==='win32'?root?.toLowerCase()??null:root})).digest('hex');
}

function draftsProjection(value){
  if(!Array.isArray(value)||value.length>100)throw new Error('Draft storage supports at most 100 nonempty drafts per project binding');
  const ids=new Set(),sessions=new Set();
  return value.map(draft=>{
    if(!draft||typeof draft!=='object'||typeof draft.id!=='string'||!ID.test(draft.id)||ids.has(draft.id)||typeof draft.text!=='string'||draft.text.length>24000||draft.text.includes('\0')||typeof draft.title!=='string'||draft.title.length>80)throw new Error('Invalid composer draft');
    if(draft.sessionId!==null&&(typeof draft.sessionId!=='string'||!SESSION_ID.test(draft.sessionId)||sessions.has(draft.sessionId)))throw new Error('Invalid or duplicate draft conversation binding');
    if(!Number.isFinite(draft.scrollTop)||draft.scrollTop<0||draft.scrollTop>1e9)throw new Error('Invalid draft scroll position');
    const historyOffset=draft.historyOffset??0;
    if(!Number.isSafeInteger(historyOffset)||historyOffset<0)throw new Error('Invalid draft history page');
    ids.add(draft.id);if(draft.sessionId!==null)sessions.add(draft.sessionId);
    return {id:draft.id,sessionId:draft.sessionId,text:draft.text,title:draft.title,scrollTop:draft.scrollTop,historyOffset};
  });
}

/** Stores unsent composer data only; submitted history/task execution stays CLI-owned. */
export class ComposerDraftStore{
  #tail=Promise.resolve();
  constructor(profileDirectory){
    if(typeof profileDirectory!=='string'||!isAbsolute(profileDirectory))throw new Error('An absolute draft profile is required');
    this.directory=join(profileDirectory,'composer-drafts');
  }
  async #path(scope){
    if(typeof scope!=='string'||!SCOPE.test(scope))throw new Error('Invalid draft scope');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const directory=await lstat(this.directory);
    if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('Draft storage must be a regular directory');
    return join(await realpath(this.directory),`${scope}.json`);
  }
  async #read(scope){
    const path=await this.#path(scope);
    let handle;
    try{
      const before=await lstat(path);
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_BYTES)throw new Error('Draft storage is unsafe or too large');
      handle=await open(path,'r');
      const actual=await handle.stat();
      if(!actual.isFile()||actual.nlink!==1||actual.ino!==before.ino||actual.dev!==before.dev||actual.size>MAX_BYTES)throw new Error('Draft storage changed while opening');
      const buffer=Buffer.alloc(actual.size);
      let offset=0;
      while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
      const after=await handle.stat();
      if(offset!==buffer.length||after.size!==actual.size||after.mtimeMs!==actual.mtimeMs)throw new Error('Draft storage changed while reading');
      let value;try{value=JSON.parse(buffer.toString('utf8'));}catch{throw new Error('Draft storage is not valid JSON; existing data was preserved');}
      if(value?.version!==1)return {version:value?.version??null,readOnly:true,reason:'This draft schema is unsupported. Use a compatible Desktop version.',scope,revision:null,drafts:[]};
      if(value.scope!==scope||!Number.isSafeInteger(value.revision)||value.revision<0)throw new Error('Draft storage binding is invalid');
      return {version:1,scope,revision:value.revision,drafts:draftsProjection(value.drafts),readOnly:false};
    }catch(error){if(error.code==='ENOENT')return {version:1,scope,revision:0,drafts:[],readOnly:false};throw error;}
    finally{await handle?.close();}
  }
  read(scope){return this.#tail.then(()=>this.#read(scope));}
  whenIdle(){return this.#tail;}
  write(scope,request){
    const operation=this.#tail.then(async()=>{
      const drafts=draftsProjection(request?.drafts);
      const current=await this.#read(scope);
      if(current.readOnly)throw new Error('Draft storage is read-only because its schema is unsupported');
      if(request?.scope!==scope||request.revision!==current.revision)throw new Error('Draft storage changed. Reopen the conversation before saving again.');
      if(current.revision===Number.MAX_SAFE_INTEGER)throw new Error('Draft revision limit reached');
      const next={version:1,scope,revision:current.revision+1,drafts};
      const bytes=Buffer.from(JSON.stringify(next));
      if(bytes.length>MAX_BYTES)throw new Error('Draft storage is full. Shorten or remove a draft before saving.');
      const path=await this.#path(scope),temporary=`${path}.${randomUUID()}.tmp`;
      let handle;
      try{
        handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
        await rename(temporary,path);
      }finally{await handle?.close();await rm(temporary,{force:true});}
      return {version:1,scope,revision:next.revision,saved:true};
    });
    this.#tail=operation.then(()=>{},()=>{});
    return operation;
  }
}

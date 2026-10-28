import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {lstatSync,readlinkSync,openSync,closeSync,fstatSync,readFileSync,constants,type BigIntStats} from 'node:fs'
import {resolve,relative,win32,posix} from 'node:path'
import {recoveryTargetIdentity} from './recoveryIdentity.js'
import {isCredentialTargetPath} from '../autonomyEnforcement.js'

type FileFact = { kind:'missing' } | { kind:'file'|'link'; dev:string; ino:string; mode:string; hash:string }
export interface RecoveryPatchSnapshot { index:string; files:Map<string,FileFact> }
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')

/** Bounded to the selected repository; no following a switched file handle. */
export function recoveryPatchFileFact(root:string,path:string):FileFact {
  if(isCredentialTargetPath(path)||recoveryTargetIdentity(root,path)===null)throw Error('Uncontained recovery patch input')
  const absolute=resolve(root,path)
  let stat:BigIntStats
  try{stat=lstatSync(absolute,{bigint:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {kind:'missing'};throw error}
  if(recoveryTargetIdentity(root,path)===null)throw Error('Recovery path switched')
  if(stat.isSymbolicLink())return {kind:'link',dev:String(stat.dev),ino:String(stat.ino),mode:String(stat.mode),hash:hash(readlinkSync(absolute))}
  if(!stat.isFile())throw Error('Recovery input is not a file')
  const fd=openSync(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  try{
    const opened=fstatSync(fd,{bigint:true})
    if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino||opened.mode!==stat.mode)throw Error('Recovery input switched before read')
    const bytes=readFileSync(fd)
    const after=lstatSync(absolute,{bigint:true})
    if(after.dev!==opened.dev||after.ino!==opened.ino||after.mode!==opened.mode||!after.isFile())throw Error('Recovery input switched during read')
    return {kind:'file',dev:String(opened.dev),ino:String(opened.ino),mode:String(opened.mode),hash:hash(bytes)}
  }finally{closeSync(fd)}
}

/** One path identity for initial and completed facts; case folding is Windows-only. */
export function recoveryPatchSnapshotKey(root:string,path:string,known:Iterable<string>,platform:NodeJS.Platform=process.platform):string {
  const api=platform==='win32'?win32:posix
  const key=api.relative(root,api.resolve(root,path)).replaceAll('\\','/')
  if(!key||key==='..'||key.startsWith('../')||api.isAbsolute(key))throw Error('Recovery snapshot path escaped selected root')
  return [...known].find(candidate=>platform==='win32'?candidate.toLowerCase()===key.toLowerCase():candidate===key)??key
}

export function captureRecoveryPatchSnapshot(root:string,extraPaths:readonly string[]=[]):RecoveryPatchSnapshot {
  const git=(args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],windowsHide:true,timeout:10000,maxBuffer:16*1024*1024})
  const index=hash(JSON.stringify([git(['rev-parse','HEAD']),git(['ls-files','--stage','-z'])]))
  const paths=[...new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))].sort()
  for(const raw of extraPaths){const path=recoveryPatchSnapshotKey(root,raw,paths);if(!paths.some(key=>process.platform==='win32'?key.toLowerCase()===path.toLowerCase():key===path))paths.push(path)}
  paths.sort()
  return {index,files:new Map(paths.map(path=>[path,recoveryPatchFileFact(root,path)]))}
}

/** Only confirmed writes of this batch may replace original repository facts. */
export function recoveryPatchSnapshotMatches(root:string,initial:RecoveryPatchSnapshot,completed:ReadonlyMap<string,FileFact>):boolean {
  try{
    const current=captureRecoveryPatchSnapshot(root,[...initial.files.keys(),...completed.keys()])
    if(current.index!==initial.index)return false
    const expected=new Map(initial.files)
    for(const [path,fact]of completed)expected.set(recoveryPatchSnapshotKey(root,path,expected.keys()),fact)
    if(current.files.size!==expected.size)return false
    return [...expected].every(([path,fact])=>JSON.stringify(current.files.get(path))===JSON.stringify(fact))
  }catch{return false}
}

/** A foreign post-dispatch observation is never adopted as this patch's effect. */
export function captureCompletedRecoveryPatchFact(root:string,path:string,intended:string,provedHash?:string):FileFact {
  const fact=recoveryPatchFileFact(root,path)
  const intendedHash=hash(intended)
  if(fact.kind!=='file'||fact.hash!==intendedHash||(provedHash!==undefined&&provedHash!==intendedHash))throw Error('Recovery patch postimage is not the proved intended write')
  return fact
}

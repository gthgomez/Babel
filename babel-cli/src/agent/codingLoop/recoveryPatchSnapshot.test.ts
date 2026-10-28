import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {captureCompletedRecoveryPatchFact} from './recoveryPatchSnapshot.js'

test('only an intended proven postimage can enter completed batch facts',()=>{
 const root=mkdtempSync(join(tmpdir(),'babel-patch-postimage-'))
 try{
  const path=join(root,'source.ts');const intended='export const value=2;\n';const hash=createHash('sha256').update(intended).digest('hex')
  writeFileSync(path,intended)
  assert.equal(captureCompletedRecoveryPatchFact(root,'source.ts',intended,hash).kind,'file')
  assert.throws(()=>captureCompletedRecoveryPatchFact(root,'source.ts',intended,'other-proof'))
  writeFileSync(path,'foreign content\n')
  assert.throws(()=>captureCompletedRecoveryPatchFact(root,'source.ts',intended,hash))
  rmSync(path);assert.throws(()=>captureCompletedRecoveryPatchFact(root,'source.ts',intended,hash))
  mkdirSync(path);assert.throws(()=>captureCompletedRecoveryPatchFact(root,'source.ts',intended,hash))
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('snapshot path keys preserve POSIX distinctions and normalize dot/Windows aliases without cross-drive joining',async()=>{
 const {recoveryPatchSnapshotKey}=await import('./recoveryPatchSnapshot.js')
 assert.equal(recoveryPatchSnapshotKey('/repo','./src/Value.ts',['src/Value.ts'],'linux'),'src/Value.ts')
 assert.equal(recoveryPatchSnapshotKey('/repo','src/value.ts',['src/Value.ts'],'linux'),'src/value.ts')
 assert.equal(recoveryPatchSnapshotKey('D:\\repo','.\\src\\value.ts',['src/Value.ts'],'win32'),'src/Value.ts')
 assert.throws(()=>recoveryPatchSnapshotKey('D:\\repo','C:\\outside\\value.ts',[],'win32'))
})

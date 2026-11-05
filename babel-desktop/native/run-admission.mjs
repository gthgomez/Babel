import {mkdir,lstat,open} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';

/** Durable at-most-once admission, including a crash between claiming and spawn.
 * Receipts contain only submission IDs, never tasks or credentials. An uncertain
 * launch stays consumed: inspect its session and submit a new ID to retry work.
 */
export class RunAdmissionLedger {
  constructor(directory){
    if(typeof directory!=='string'||!isAbsolute(directory))throw new TypeError('An absolute admission directory is required');
    this.directory=directory;
  }
  async claim(runId){
    if(typeof runId!=='string'||!/^[\w-]{1,100}$/.test(runId))throw new TypeError('Invalid run ID');
    await mkdir(this.directory,{recursive:true});
    const info=await lstat(this.directory);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Run admission storage is unsafe');
    let file;
    // Opaque names avoid Windows device names and case-insensitive ID collisions.
    const name=createHash('sha256').update(runId).digest('hex');
    try{file=await open(join(this.directory,`${name}.json`),'wx',0o600);}
    catch(error){if(error.code==='EEXIST')return false;throw error;}
    try{
      await file.writeFile(JSON.stringify({schemaVersion:1,runId})+'\n');
      await file.sync();
    }finally{await file.close();}
    return true;
  }
}

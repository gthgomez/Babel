import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';

/** Open only regular canonical archive files. A transcript must never become a file-viewer escape. */
export async function openSessionFile(base, sessionId, filename) {
  if (!/^[\w-]{1,80}$/.test(sessionId) || !['transcript.jsonl','session-events.jsonl'].includes(filename)) throw new Error('Invalid session file scope');
  const root=await realpath(base);
  const directory=path.join(root,sessionId);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked session directories are outside archive scope');
  const target=path.join(directory,filename);
  const before=await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Linked or nonregular archive files are outside scope');
  const canonical=await realpath(target);
  const contained=value=>{const relative=path.relative(root,value);return relative!== '..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
  if (!contained(canonical)) throw new Error('Archive path escapes session scope');
  const handle=await open(canonical,'r');
  try {
    const actual=await handle.stat();
    if (!actual.isFile() || actual.ino!==before.ino || actual.dev!==before.dev || !contained(await realpath(target))) throw new Error('Archive changed while opening; retry');
    return handle;
  } catch(error) {await handle.close();throw error;}
}

export async function readSnapshot(handle,size) {
  const buffer=Buffer.alloc(size);
  let offset=0;
  while(offset<size){const {bytesRead}=await handle.read(buffer,offset,size-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  return buffer.subarray(0,offset).toString('utf8');
}

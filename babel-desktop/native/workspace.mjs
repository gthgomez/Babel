import { readdir, realpath, lstat, open } from 'node:fs/promises';
import path from 'node:path';

const HIDDEN = new Set(['.git','node_modules','.venv','venv','__pycache__','.ssh','.aws','.azure','.gnupg','.config','.kube','.npmrc','.pypirc','.netrc','credentials','credentials.json','secrets','secrets.json','id_rsa','id_ed25519','id_ecdsa','keychain','cookies']);
function denied(name) {
  const lower = name.toLowerCase();
  return HIDDEN.has(lower) || /^\.env(?:\.|$)/i.test(name) || /(?:^|[._-])(?:credentials|secrets?|tokens?)(?:[._-]|$)/i.test(name) || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name);
}
function partsOf(relative) {
  if (typeof relative !== 'string' || relative.length > 2048 || relative.includes('\0') || relative.includes(':') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error('Invalid project-relative path');
  const parts = relative.replace(/\\/g,'/').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..' || denied(p))) throw new Error('This path is outside the permitted file-viewing scope');
  return parts;
}
async function resolveScoped(root, relative) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Select a project first');
  const base = await realpath(root);
  let target = base;
  for (const part of partsOf(relative)) {
    target = path.join(target,part);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Linked paths are not opened by the file viewer');
  }
  const canonical = await realpath(target);
  const relation = path.relative(base,canonical);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw new Error('Path escapes the selected project');
  return canonical;
}
export async function listDirectory(root, relative = '.') {
  const target = await resolveScoped(root,relative);
  const entries = await readdir(target,{withFileTypes:true});
  return entries.filter(item => !denied(item.name) && !item.isSymbolicLink() && (item.isDirectory() || item.isFile()))
    .sort((a,b) => Number(b.isDirectory())-Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0,300).map(item => ({name:item.name,type:item.isDirectory()?'folder':'file',...(item.isDirectory()?{children:[],loaded:false}:{})}));
}
export async function readProjectFile(root, relative) {
  const target = await resolveScoped(root,relative);
  const before = await lstat(target);
  if (!before.isFile()) throw new Error('Only regular text files can be opened');
  // Recheck opened inode to detect a replacement between path validation and open.
  const handle = await open(target,'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('File changed while opening; retry');
    const bytes = Buffer.alloc(Math.min(stat.size,256*1024));
    const {bytesRead} = await handle.read(bytes,0,bytes.length,0);
    const content = bytes.subarray(0,bytesRead);
    if (content.includes(0)) throw new Error('Binary files are not shown in the text viewer');
    return {text:content.toString('utf8'),truncated:stat.size>bytesRead};
  } finally { await handle.close(); }
}

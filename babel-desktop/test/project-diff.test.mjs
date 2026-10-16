import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('project diff shows staged and unstaged edits, additions and deletions without modifying the checkout',async()=>{
  const {readProjectDiff}=await import('../native/project-diff.mjs');
  const root=await mkdtemp(join(tmpdir(),'babel-project-diff-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  try{
    // Disposable fixture repository only; every native failure throws.
    git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await writeFile(join(root,'tracked.txt'),'before\n');await writeFile(join(root,'deleted.txt'),'removed\n');
    git('add','.');git('commit','-qm','fixture');
    await writeFile(join(root,'tracked.txt'),'staged\n');git('add','tracked.txt');await writeFile(join(root,'tracked.txt'),'after\n');
    await writeFile(join(root,'new[1].txt'),'new content\n');await rm(join(root,'deleted.txt'));
    git('add','deleted.txt');
    const before=git('status','--porcelain=v1');
    const changed=await readProjectDiff(root,'tracked.txt');
    assert.match(changed.diff,/-before\n\+after/);assert.match(changed.baseRevision,/^[a-f0-9]{40,64}$/);
    assert.equal(changed.kind,'tracked');assert.equal(changed.truncated,false);
    const prior=process.env.GIT_DIR;
    try{process.env.GIT_DIR=join(root,'nonexistent-ambient-override');assert.match((await readProjectDiff(root,'tracked.txt')).diff,/\+after/);}
    finally{if(prior===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=prior;}
    const added=await readProjectDiff(root,'new[1].txt');assert.equal(added.kind,'added');assert.match(added.diff,/\+new content/);
    const deleted=await readProjectDiff(root,'deleted.txt');assert.match(deleted.diff,/-removed/);
    assert.equal(git('status','--porcelain=v1'),before);assert.equal(await readFile(join(root,'tracked.txt'),'utf8'),'after\n');
    await assert.rejects(()=>readProjectDiff(root,'../outside'),/scope|path/i);
    await assert.rejects(()=>readProjectDiff(root,'.env'),/scope|path/i);
    await writeFile(join(root,'tracked.txt'),'large diff\n'+'x'.repeat(1100000));
    const bounded=await readProjectDiff(root,'tracked.txt');
    assert.equal(bounded.truncated,true);assert.ok(Buffer.byteLength(bounded.diff)<=1024*1024);
    const dollarName="$'$&.txt";await writeFile(join(root,dollarName),'literal filename\n');
    assert.ok((await readProjectDiff(root,dollarName)).diff.includes(JSON.stringify(`b/${dollarName}`)));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('different invalid UTF-8 byte sequences never become a false no-change result',async()=>{
  const {readProjectDiff}=await import('../native/project-diff.mjs');
  const root=await mkdtemp(join(tmpdir(),'babel-diff-encoding-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  try{
    git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await writeFile(join(root,'raw.txt'),Buffer.from([0xff]));git('add','.');git('commit','-qm','fixture');
    await writeFile(join(root,'raw.txt'),Buffer.from([0xfe]));
    const result=await readProjectDiff(root,'raw.txt');assert.equal(result.hasChanges,null);assert.equal(result.binary,true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a new repository displays an explicit empty baseline and empty files remain visible',async()=>{
  const {readProjectDiff}=await import('../native/project-diff.mjs');
  const root=await mkdtemp(join(tmpdir(),'babel-diff-unborn-'));
  try{
    execFileSync('git',['-C',root,'init','-q'],{windowsHide:true,stdio:'pipe'});
    await writeFile(join(root,'empty.txt'),'');
    const empty=await readProjectDiff(root,'empty.txt');
    assert.equal(empty.baseRevision,null);assert.equal(empty.hasChanges,true);assert.match(empty.diff,/new file/);
    await assert.rejects(()=>readProjectDiff(root,'missing.txt'),/unavailable/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diff does not invoke external diff/textconv commands or follow linked project paths',async()=>{
  const {readProjectDiff}=await import('../native/project-diff.mjs');
  const root=await mkdtemp(join(tmpdir(),'babel-diff-boundary-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  try{
    git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await writeFile(join(root,'file.txt'),'before\n');await writeFile(join(root,'.gitattributes'),'*.txt diff=fixture\n');git('add','.');git('commit','-qm','fixture');
    git('config','diff.external','definitely-missing-external-diff');git('config','diff.fixture.textconv','definitely-missing-textconv');
    const marker=join(root,'fsmonitor-invoked.txt'),monitor=join(root,'monitor.mjs');
    await writeFile(monitor,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'called');`);
    git('config','core.fsmonitor',`"${process.execPath}" "${monitor}"`);
    await writeFile(join(root,'file.txt'),'after\n');
    assert.match((await readProjectDiff(root,'file.txt')).diff,/\+after/);
    await assert.rejects(()=>stat(marker),{code:'ENOENT'});
    const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'file.txt'),'synthetic outside');
    await symlink(outside,join(root,'linked'),'junction');
    await assert.rejects(()=>readProjectDiff(root,'linked/file.txt'),/link|scope/i);
    git('config','core.worktree',outside);
    await assert.rejects(()=>readProjectDiff(root,'file.txt'),/scope/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('deleted directory requests cannot disclose protected descendants through a recursive pathspec',async()=>{
  const {readProjectDiff}=await import('../native/project-diff.mjs');
  const root=await mkdtemp(join(tmpdir(),'babel-diff-deleted-scope-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  try{
    git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await mkdir(join(root,'gone'));await writeFile(join(root,'gone','.env'),'SYNTHETIC-PRIVATE-CONTENT\n');await writeFile(join(root,'gone','visible.txt'),'visible\n');
    git('add','.');git('commit','-qm','fixture');await rm(join(root,'gone'),{recursive:true});
    await assert.rejects(()=>readProjectDiff(root,'gone'),/directory|file|scope/i);
    await writeFile(join(root,'gone'),'replacement file\n');
    await assert.rejects(()=>readProjectDiff(root,'gone'),/directory|file|scope/i);
    await rm(join(root,'gone'));
    assert.match((await readProjectDiff(root,'gone/visible.txt')).diff,/-visible/);
    await assert.rejects(()=>readProjectDiff(root,'gone/.env'),/scope|path/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('configured clean filters cannot execute during isolated raw snapshot comparison',async()=>{
  const {readProjectDiff}=await import('../native/project-diff.mjs');
  const root=await mkdtemp(join(tmpdir(),'babel-diff-clean-filter-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  try{
    git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await writeFile(join(root,'file.txt'),'before\n');git('add','.');git('commit','-qm','fixture');
    const marker=join(root,'filter-called'),filter=join(root,'filter.mjs');
    await writeFile(filter,`import {writeFileSync,readFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'called');process.stdout.write(readFileSync(0));`);
    await writeFile(join(root,'.gitattributes'),'*.txt filter=fixture\n');
    git('config','filter.fixture.clean',`"${process.execPath}" "${filter}"`);
    await writeFile(join(root,'file.txt'),'after\n');
    const result=await readProjectDiff(root,'file.txt',{cacheDirectory:join(root,'private-diff-cache')});
    assert.match(result.diff,/\+after/);
    await assert.rejects(()=>stat(marker),{code:'ENOENT'});
    assert.deepEqual(await readdir(join(root,'private-diff-cache')),[]);
    await writeFile(filter,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'process called');process.exit(1);`);
    git('config','filter.fixture.process',`"${process.execPath}" "${filter}"`);
    assert.match((await readProjectDiff(root,'file.txt',{cacheDirectory:join(root,'private-diff-cache')})).diff,/\+after/);
    await assert.rejects(()=>stat(marker),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});

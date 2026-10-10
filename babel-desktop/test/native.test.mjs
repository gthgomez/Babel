import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const load = (name) => import(`../native/${name}.mjs`).catch(() => ({}));

test('closing the window quits even while a run is busy',async()=>{
 const {decideWindowClose,decideLastWindow,CLOSE_GRACE_MS}=await load('lifecycle');
 assert.equal(decideWindowClose({busy:false,closing:false}),'close');
 assert.equal(decideWindowClose({busy:true,closing:false}),'cancel-then-close');
 assert.equal(decideWindowClose({busy:true,closing:true}),'close');
 assert.equal(decideLastWindow(),'quit');
 assert.equal(CLOSE_GRACE_MS>1500,true);
});
test('decoder preserves fragmented UTF-8 and fragmented JSON lines',async()=>{
 const {JsonlDecoder}=await load('stream');assert.equal(typeof JsonlDecoder,'function');
 const events=[],errors=[];const d=new JsonlDecoder(v=>events.push(v),v=>errors.push(v));
 const b=Buffer.from('{"type":"assistant_chunk","chunk":"café 🧪"}\n');
 for(let i=0;i<b.length;i++)d.push(b.subarray(i,i+1));d.end();
 assert.equal(events[0].chunk,'café 🧪');assert.deepEqual(errors,[]);
});
test('decoder bounds oversized lines and recovers for following events',async()=>{
 const {JsonlDecoder}=await load('stream');assert.equal(typeof JsonlDecoder,'function');
 const events=[],errors=[];const d=new JsonlDecoder(v=>events.push(v),v=>errors.push(v),{maxLineBytes:64});
 d.push(Buffer.from('x'.repeat(100)));d.push(Buffer.from('more\n{"type":"run_start"}\n'));d.end();
 assert.equal(errors.length,1);assert.equal(events[0].type,'run_start');
});
test('decoder reports malformed data without treating it as successful output',async()=>{
 const {JsonlDecoder}=await load('stream');assert.equal(typeof JsonlDecoder,'function');
 const events=[],errors=[];const d=new JsonlDecoder(v=>events.push(v),v=>errors.push(v));
 d.push(Buffer.from('not json\n[]\n{"type":"run_start"}'));d.end();
 assert.equal(errors.length,2);assert.deepEqual(events,[{type:'run_start'}]);
});
test('child arguments cannot turn task text into options or shell commands',async()=>{
 const {buildRunArgs}=await load('child');assert.equal(typeof buildRunArgs,'function');
 const entry=join(tmpdir(),'Babel Space','index.js');const root=join(tmpdir(),'project space');
 const task='--yes; echo unsafe && exit';const args=buildRunArgs(entry,root,{task,mode:'chat'});
 assert.deepEqual(args.slice(-2),['--',task]);
 assert.ok(args.includes('--execution-profile')&&args.includes('safe_repo'));
 assert.ok(!args.includes('--read-only'));
 assert.ok(!args.includes('--resume-chat'));
 assert.ok(!args.slice(0,-1).includes('--yes'));
 const resumed=buildRunArgs(entry,root,{task:'hello',mode:'chat',sessionId:'chat-abc123'});
 assert.ok(resumed.indexOf('--resume-chat')<resumed.lastIndexOf('--'));
 assert.equal(resumed[resumed.indexOf('--resume-chat')+1],'chat-abc123');
 assert.throws(()=>buildRunArgs(entry,root,{task:'hello',mode:'chat',sessionId:'../chat'}));
 assert.throws(()=>buildRunArgs(entry,root,{task:'hello',mode:'invented'}));
 assert.throws(()=>buildRunArgs(entry,root,{task:'',mode:'chat'}));
});
test('workspace reader rejects traversal, secrets, binary files and symlink escape',async()=>{
 const {listDirectory,readProjectFile}=await load('workspace');assert.equal(typeof readProjectFile,'function');
 const dir=await mkdtemp(join(tmpdir(),'babel-workspace-'));
 try{
  await writeFile(join(dir,'README.md'),'hello');await writeFile(join(dir,'.env'),'secret');await writeFile(join(dir,'binary.bin'),Buffer.from([0,1,2]));
  await assert.rejects(()=>readProjectFile(dir,'../elsewhere'));
  await assert.rejects(()=>readProjectFile(dir,'.env'));
  await assert.rejects(()=>readProjectFile(dir,'C:\\Windows\\file'));
  await assert.rejects(()=>readProjectFile(dir,'binary.bin'));
  const text=await readProjectFile(dir,'README.md');assert.equal(text.text,'hello');
  const files=await listDirectory(dir,'.');assert.ok(!files.some(f=>f.name==='.env'));
  if(process.platform!=='win32'){await symlink(tmpdir(),join(dir,'outside'));await assert.rejects(()=>readProjectFile(dir,'outside/anything'));}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('read-only child transport emits fixture events and rejects concurrent execution',async()=>{
 const {BabelChild}=await load('child');assert.equal(typeof BabelChild,'function');
 const events=[];const entry=fileURLToPath(new URL('./fixture-cli.mjs',import.meta.url));
 const child=new BabelChild({executable:process.execPath,entry,projectRoot:tmpdir()});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Fixture child failed to finish')),4000);
  child.start({runId:'test-run',task:'Read a fixture',mode:'chat'},packet=>{events.push(packet);if(packet.kind==='exit'){clearTimeout(timer);resolve();}});
  assert.throws(()=>child.start({runId:'two',task:'another',mode:'chat'},()=>{}),/already running/);
 });
 assert.equal(child.busy,false);
 assert.ok(events.some(p=>p.kind==='event'&&p.event.type==='assistant_chunk'));
 assert.ok(events.every(p=>p.runId==='test-run'));
 assert.equal(events.at(-1).code,0);
});

test('saved chats are read from Babel session transcripts only',async()=>{
 const {listSavedChats,readSavedChat,messagesFromTranscript}=await load('sessions');
 assert.equal(typeof listSavedChats,'function');
 assert.equal(messagesFromTranscript('{"role":"system","content":"hidden"}\n{"role":"user","content":"Fix the timeout"}\n{"role":"tool","content":"skip"}\n{"role":"assistant","content":"Done."}\n').map(m=>m.role).join(','), 'user,assistant');
 const root=await mkdtemp(join(tmpdir(),'babel-desktop-sessions-'));
 const desktop=join(root,'babel-desktop');
 const session=join(root,'runs','chat-sessions','chat-abc123');
 await mkdir(session,{recursive:true});
 await mkdir(desktop);
 await writeFile(join(session,'transcript.jsonl'),'{"role":"user","content":"Fix the timeout"}\n{"role":"assistant","content":"I updated the controller."}\n{"role":"user","content":"finish"}\n');
 await writeFile(join(root,'runs','chat-sessions','..bad','transcript.jsonl'),'{"role":"user","content":"no"}\n').catch(()=>{});
 const listed=await listSavedChats(desktop);
 assert.equal(listed.length,1);
 assert.equal(listed[0].id,'chat-abc123');
 assert.equal(listed[0].title,'Fix the timeout');
 assert.equal(listed[0].title.includes('finish'),false);
 const opened=await readSavedChat(desktop,'chat-abc123');
 assert.equal(opened.messages[1].text,'I updated the controller.');
 assert.equal(opened.messages[1].status,'unverified');
 await writeFile(join(session,'session-events.jsonl'),`${JSON.stringify({kind:'turn_ended',turn_id:'1',outcome:'VERIFIED_COMPLETE',status:'ok'})}\n${JSON.stringify({kind:'turn_ended',turn_id:'2',outcome:'AGENT_FAILURE',status:'failed'})}\n`);
 const withOutcomes=await readSavedChat(desktop,'chat-abc123');
 assert.equal(withOutcomes.messages[1].status,'complete');
 assert.equal(withOutcomes.messages.length,3);
 await assert.rejects(()=>readSavedChat(desktop,'../chat-abc123'));
 await rm(root,{recursive:true,force:true});
});
test('official runtime resolves the sibling babel-cli build',async()=>{
 const {resolveOfficialCli}=await load('runtime');assert.equal(typeof resolveOfficialCli,'function');
 const dir=await mkdtemp(join(tmpdir(),'babel-desktop-runtime-'));
 try{
  const desktop=join(dir,'babel-desktop');
  const cli=join(dir,'babel-cli','dist','index.js');
  await mkdir(desktop);
  const missing=resolveOfficialCli(desktop);
  assert.equal(missing.ready,false);
  assert.equal(missing.label,'babel-cli/dist/index.js');
  await mkdir(join(dir,'babel-cli','dist'),{recursive:true});
  await writeFile(cli,'');
  const found=resolveOfficialCli(desktop);
  assert.equal(found.ready,true);
  assert.equal(found.path,cli);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('native origin admits only the packaged application document',async()=>{
 const {isAppUrl}=await load('security');assert.equal(typeof isAppUrl,'function');
 assert.equal(isAppUrl('babel://app/index.html'),true);
 for(const url of ['https://app/index.html','babel://evil/index.html','babel://app/index.html?x=1','babel://app/index.html#x','babel://app/../other','file:///tmp/index.html']) assert.equal(isAppUrl(url),false,url);
});
test('native preferences contain only absolute UI connection paths',async()=>{
 const {parsePreferences}=await load('security');assert.equal(typeof parsePreferences,'function');
 assert.deepEqual(parsePreferences({cliEntry:join(tmpdir(),'index.js'),projectRoot:tmpdir(),apiKey:'never persisted'}),{cliEntry:join(tmpdir(),'index.js'),projectRoot:tmpdir(),projectCredentialRoot:null});
 assert.deepEqual(parsePreferences({cliEntry:'relative.js',projectRoot:[],projectCredentialRoot:'relative'}),{cliEntry:null,projectRoot:null,projectCredentialRoot:null});
 assert.equal(parsePreferences({projectRoot:tmpdir(),projectCredentialRoot:tmpdir()}).projectCredentialRoot,tmpdir());
});

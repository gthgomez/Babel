// Real Linux pseudo-terminal startup with a synthetic profile and denied network.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs';

const entry=fileURLToPath(new URL('../../bin/babel.js',import.meta.url));
const bootstrap=new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href;
const shellQuote=value=>`'${String(value).replaceAll("'","'\\''")}'`;

test('Linux terminal opens the offline workspace and exits without provider traffic',
  {skip:process.platform!=='linux',timeout:120000},async t=>{
    const fixture=prepareSyntheticProviderFixture();
    try{
      const shellEnv=join(fixture.root,'terminal-shell-env.mjs');
      // util-linux script's shell adds PWD; the fixture otherwise accepts only
      // its allowlisted, isolated environment and still denies every socket.
      writeFileSync(shellEnv,`import {spawnSync} from 'node:child_process'; const tty=spawnSync('/usr/bin/stty',['rows','24','cols','80'],{stdio:'inherit'}); if(tty.status!==0)throw Error('Could not size the synthetic terminal'); delete process.env.PWD; for(const [name,value] of [['BABEL_OFFLINE','1'],['TERM','xterm']]){if(process.env[name]!==undefined&&process.env[name]!==value)throw Error('Unexpected terminal fixture environment');delete process.env[name]} await import(${JSON.stringify(bootstrap)}); process.env.BABEL_OFFLINE='1'; process.env.TERM='xterm';\n`);
      const command=[process.execPath,'--import',pathToFileURL(shellEnv).href,entry,'interactive'].map(shellQuote).join(' ');
      const started=performance.now();
      const child=spawn('script',['-q','-f','-e','-c',command,'/dev/null'],{cwd:fixture.cwd,env:fixture.env,stdio:['pipe','pipe','pipe'],detached:true});
      let output='',sent=false,composerMs=null;
      const observe=chunk=>{output+=String(chunk);if(!sent&&/Input[^\n]{0,40}›/.test(output)){sent=true;composerMs=Math.round(performance.now()-started);child.stdin.write('/exit\n');}};
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',observe);child.stderr.on('data',observe);
      const watchdog=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},90000);
      const outcome=await new Promise(resolve=>{child.once('error',()=>resolve({code:null}));child.once('close',code=>resolve({code}));});
      clearTimeout(watchdog);
      const hints=['SYNTHETIC_PROVIDER_FIXTURE_ISOLATION_INVALID','SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED','Cannot find module','Unknown command','unsupported','ERR_MODULE_NOT_FOUND','Permission denied'].filter(value=>output.toLowerCase().includes(value.toLowerCase()));
      const stack=output.split(/\r?\n/).filter(line=>/^\s*at |^Error:/.test(line)).slice(-8).map(line=>line.replace(/synthetic-(?:router|deepseek|go)-credential/g,'[synthetic]')).join(' | ');
      const tail=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/synthetic-(?:router|deepseek|go)-credential/g,'[synthetic]').slice(-900);
      assert.equal(outcome.code,0,`Terminal did not exit cleanly; composer=${sent}; output characters=${output.length}; matched diagnostics=${hints.join(',')||'none'}; stack=${stack}; tail=${tail}`);
      assert.match(output,/babel/i);
      assert.equal(sent,true,'The composer did not appear');
      assert.doesNotMatch(output,/synthetic-router-credential|synthetic-deepseek-credential|SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED/);
      t.diagnostic(JSON.stringify({launchToComposerMs:composerMs,launchToExitMs:Math.round(performance.now()-started),runtime:process.version}));
    }finally{removeSyntheticProviderFixture(fixture.root);}
  });

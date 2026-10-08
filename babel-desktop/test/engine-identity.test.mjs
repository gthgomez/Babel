// License: Apache-2.0 - see LICENSE
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyOrigin, parseBuildMetadata, describeSource, normalizeUpdate, resolveEngineIdentity} from '../native/identity.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('classifyOrigin distinguishes packaged, official, advanced and missing', () => {
  assert.equal(classifyOrigin({isPackaged:true, advancedEntry:false, officialReady:true}), 'bundled');
  assert.equal(classifyOrigin({isPackaged:true, advancedEntry:true, officialReady:true}), 'bundled');
  assert.equal(classifyOrigin({isPackaged:true, advancedEntry:false, officialReady:false}), 'missing');
  assert.equal(classifyOrigin({isPackaged:false, advancedEntry:false, officialReady:true}), 'official');
  assert.equal(classifyOrigin({isPackaged:false, advancedEntry:true, officialReady:false}), 'advanced');
  assert.equal(classifyOrigin({isPackaged:false, advancedEntry:false, officialReady:false}), 'missing');
});

test('parseBuildMetadata reads only real provenance and never invents fields', () => {
  const parsed = parseBuildMetadata(JSON.stringify({version:'0.1.1', cliVersion:'0.1.1', sourceSha:SHA_A, platform:'win32-x64', signed:false}));
  assert.deepEqual(parsed, {version:'0.1.1', cliVersion:'0.1.1', sourceSha:SHA_A, platform:'win32-x64', signed:false});
  assert.equal(parseBuildMetadata('not json'), null);
  assert.equal(parseBuildMetadata(JSON.stringify({version:'0.1.1'})).sourceSha, null);
  assert.equal(parseBuildMetadata(JSON.stringify({sourceSha:'short'})).sourceSha, null);
});

test('describeSource treats an invalid or absent commit as explicitly unknown', () => {
  assert.deepEqual(describeSource({}), {kind:'unknown', commitSha:null, branch:null, dirty:null});
  assert.deepEqual(describeSource({commitSha:'nope'}), {kind:'unknown', commitSha:null, branch:null, dirty:null});
  assert.deepEqual(describeSource({commitSha:SHA_A, branch:'main', dirty:true}), {kind:'git', commitSha:SHA_A, branch:'main', dirty:true});
  assert.equal(describeSource({commitSha:SHA_A, branch:'HEAD'}).branch, null);
});

test('normalizeUpdate never reports current/available without a check', () => {
  assert.equal(normalizeUpdate({}).state, 'unchecked');
  assert.equal(normalizeUpdate({state:'bogus'}).state, 'unchecked');
  assert.equal(normalizeUpdate({state:'available', availableSha:SHA_B, currentSha:'x'}).availableSha, SHA_B);
  assert.equal(normalizeUpdate({state:'available', availableSha:'x'}).availableSha, null);
});

test('resolveEngineIdentity reports packaged provenance from BUILD.json', () => {
  const files = new Map([
    ['/app/BUILD.json', JSON.stringify({version:'0.1.1', cliVersion:'0.1.1', sourceSha:SHA_A, platform:'win32-x64', signed:false})],
    ['/app/resources/babel-runtime/cli/package.json', JSON.stringify({version:'0.1.1'})],
  ]);
  const identity = resolveEngineIdentity({
    isPackaged:true, resourcesPath:'/app/resources', desktopVersion:'0.1.1',
    cliEntry:'/app/resources/babel-runtime/cli/dist/index.js', official:{ready:true, label:'Bundled Babel CLI', source:'bundled'},
    ready:true, executionProfile:'safe_repo', diagnostics:{provider:'configured', docker:'available'},
    readText:path => { if (!files.has(path)) throw new Error('missing'); return files.get(path); },
  });
  assert.equal(identity.origin, 'bundled');
  assert.equal(identity.cliPackageVersion, '0.1.1');
  assert.equal(identity.buildVersion, '0.1.1');
  assert.equal(identity.source.commitSha, SHA_A);
  assert.equal(identity.readiness.provider, 'configured');
  assert.equal(identity.update.state, 'unchecked');
});

test('resolveEngineIdentity reports the source commit and dirty state for a checkout', () => {
  const files = new Map([['/repo/babel-cli/package.json', JSON.stringify({version:'0.1.1'})]]);
  const gitCalls = [];
  const git = (args, cwd) => {
    gitCalls.push([args.join(' '), cwd]);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return {ok:true, stdout:`${SHA_B}\n`};
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return {ok:true, stdout:'main\n'};
    if (args[0] === 'status') return {ok:true, stdout:' M src/x.ts\n'};
    return {ok:false, stdout:''};
  };
  const identity = resolveEngineIdentity({
    isPackaged:false, desktopVersion:'0.1.1', cliEntry:'/repo/babel-cli/dist/index.js',
    official:{ready:true, label:'babel-cli/dist/index.js', source:'official'}, ready:true,
    readText:path => { if (!files.has(path)) throw new Error('missing'); return files.get(path); }, git,
  });
  assert.equal(identity.origin, 'official');
  assert.equal(identity.cliPackageVersion, '0.1.1');
  assert.equal(identity.source.commitSha, SHA_B);
  assert.equal(identity.source.branch, 'main');
  assert.equal(identity.source.dirty, true);
  assert.equal(gitCalls[0][1], '/repo/babel-cli/dist');
});

test('resolveEngineIdentity stays unknown when git is unavailable', () => {
  const identity = resolveEngineIdentity({
    isPackaged:false, desktopVersion:'0.1.1', cliEntry:'/elsewhere/cli/dist/index.js',
    official:{ready:false, label:null, source:null}, advancedEntry:true, ready:false,
    readText:() => { throw new Error('missing'); }, git:() => ({ok:false, stdout:''}),
  });
  assert.equal(identity.origin, 'advanced');
  assert.equal(identity.cliPackageVersion, null);
  assert.deepEqual(identity.source, {kind:'unknown', commitSha:null, branch:null, dirty:null});
});

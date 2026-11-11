// License: Apache-2.0
// Startup work: admission must not spawn redundant capability/doctor children,
// and the doctor must be shared instead of duplicated for one execution profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../native/main.mjs',import.meta.url),'utf8');

function region(startMarker,endMarker){
  const start=source.indexOf(startMarker);
  assert.ok(start>=0,`${startMarker} must exist`);
  const end=source.indexOf(endMarker,start);
  assert.ok(end>start,`${endMarker} must follow ${startMarker}`);
  return source.slice(start,end);
}

test('the run path resolves the credential environment once for doctor and child',()=>{
  const run=region("handle('babel:run'","handleBabelPacket(packet)");
  const resolutions=[...run.matchAll(/ownedCliEnvironment\(\)/g)];
  // Exactly one direct resolution in the run path: the diagnostic environment is
  // reused for the child instead of being resolved again with a stale key.
  assert.equal(resolutions.length,1,`expected one credential resolution, found ${resolutions.length}`);
  assert.match(run,/const runEnvironment=await ownedCliEnvironment\(\)/);
  assert.match(run,/sharedDiagnostics\(officialRuntime\(\),\s*\{env:runEnvironment/);
  assert.match(run,/applySelectedModelEnvironment\(runEnvironment,selectedModel\)/);
});

test('admission uses read-only getInfo so it cannot trigger a nested doctor',()=>{
  const run=region("handle('babel:run'","handleBabelPacket(packet)");
  assert.match(run,/getInfo\(\{passive:true\}\)/);
  // A bare getInfo() call would let admission spawn its own doctor. Strip
  // comments before looking, since the code deliberately documents the rule.
  const code=run.replace(/\/\/[^\n]*/g,'');
  assert.doesNotMatch(code,/\bgetInfo\(\)/, 'A bare getInfo() may run doctor inside admission.');
});

test('getInfo skips the synchronous doctor when asked for passive information',()=>{
  const getInfo=region('async function getInfo(','async function credentialRequestContext');
  assert.match(getInfo,/passive!==true/);
  assert.match(getInfo,/app\.isPackaged&&preferences\.projectRoot&&!diagnostics&&passive!==true/);
});

test('an in-flight doctor is shared per execution profile instead of spawned repeatedly',()=>{
  const helper=region('function sharedDiagnostics','async function linuxDockerInstallation');
  assert.match(helper,/diagnosticsInFlight\?\.key===executionProfile/);
  assert.match(helper,/return diagnosticsInFlight\.promise/);
  assert.match(helper,/if\(diagnosticsInFlight\?\.promise===promise\)diagnosticsInFlight=null/);
});

test('a completed doctor is still invalidated when the connection changes',()=>{
  // Caching the finished report would hide a repaired sandbox or a new key.
  for(const channel of ["babel:save-provider-route","babel:remove-provider-credential","babel:migrate-provider-credential","babel:refresh-diagnostics","babel:configure-sandbox"]){
    const start=source.indexOf(`handle('${channel}'`);
    assert.ok(start>0,`${channel} must be registered`);
    assert.match(source.slice(start,start+2600),/diagnostics=null/,`${channel} must invalidate the cached diagnostics`);
  }
});

test('the doctor is only spawned for a packaged project run',()=>{
  const run=region("handle('babel:run'","handleBabelPacket(packet)");
  // The doctor's cost is bounded to the case that actually authorizes project
  // tools; a conversation-only or development run never pays for it here.
  const packagedBranch=run.slice(run.indexOf('if(app.isPackaged&&!conversationOnly)'),run.indexOf('// Validate native-bound scope'));
  assert.match(packagedBranch,/sharedDiagnostics/);
  assert.doesNotMatch(run,/diagnoseRuntime/,'The run path must use the shared in-flight doctor, not a direct call.');
});

test('a missing sandbox prerequisite stays fail-closed at admission',()=>{
  const run=region("handle('babel:run'","handleBabelPacket(packet)");
  const packagedBranch=run.slice(run.indexOf('if(app.isPackaged&&!conversationOnly)'),run.indexOf('// Validate native-bound scope'));
  assert.match(packagedBranch,/packagedSandboxPrerequisiteMessage/);
  assert.doesNotMatch(run,/BABEL_ALLOW_HOST_FALLBACK/,'A missing Docker must never fall back to host execution.');
});

test('the run path keeps project authority and execution-boundary revalidation',()=>{
  const run=region("handle('babel:run'","handleBabelPacket(packet)");
  // Authorization checks are never traded for latency.
  assert.match(run,/await projectAuthority\.admit\(preferences\.projectRoot\)/);
  assert.match(run,/projectAuthority\.isCurrent\(runAuthority\)/);
  assert.match(run,/resolveDesktopExecutionProfile\(request\.sessionId\)/);
  assert.match(run,/runAdmissionLedger\.claim\(request\.runId\)/);
  assert.match(run,/if\(admissionEpoch!==runAdmissionEpoch/);
});

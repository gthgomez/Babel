import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as diagnostics from '../native/diagnostics.mjs';

test('profile-aware host readiness requires a matching versioned report and never labels Docker available',()=>{
  const checks=[{id:'node',status:'ok'},{id:'resources',status:'ok'},{id:'provider',status:'warn'},
    {id:'docker',status:'not_required'},{id:'sandbox_image',status:'not_required'}];
  const report={kind:'installed_user',profileDiagnosticsVersion:1,executionProfile:'host_native',checks};
  assert.deepEqual(diagnostics.prerequisiteStatus(report,{executionProfile:'host_native'}),{
    ready:true,node:'ready',resources:'ready',provider:'missing',docker:'not_required',sandboxImage:'not_required',
  });
  assert.equal(diagnostics.prerequisiteStatus({...report,profileDiagnosticsVersion:undefined},{executionProfile:'host_native'}).ready,false);
  assert.equal(diagnostics.prerequisiteStatus({...report,executionProfile:'safe_repo'},{executionProfile:'host_native'}).ready,false);
  assert.equal(diagnostics.prerequisiteStatus({...report,checks:[...checks,{id:'docker',status:'not_required'}]},{executionProfile:'host_native'}).ready,false);
  assert.equal(diagnostics.prerequisiteStatus(report,{executionProfile:'safe_repo'}).ready,false);
});

test('diagnostics show only known prerequisite status, never raw provider text', () => {
  const result = diagnostics.prerequisiteStatus({kind:'installed_user', checks:[
    {id:'node',status:'ok',message:'private path'},
    {id:'resources',status:'ok',message:'private path'},
    {id:'provider',status:'warn',message:'secret must never render'},
    {id:'docker',status:'fail',message:'private error'},
    {id:'unknown',status:'ok',message:'secret'},
  ]});
  assert.equal(result.ready, false);
  assert.equal(result.provider, 'missing');
  assert.equal(result.docker, 'unavailable');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('malformed or incomplete diagnostics fail closed', () => {
  for (const input of [null, {}, {kind:'installed_user',checks:[]},
    {kind:'installed_user',checks:[{id:'provider',status:'ok'}]}]) {
    assert.equal(diagnostics.prerequisiteStatus(input).ready, false);
  }
});

test('credential presence remains advisory for credential-free local providers', () => {
  assert.equal(diagnostics.prerequisiteStatus({kind:'installed_user', checks:[
    {id:'node',status:'ok'}, {id:'resources',status:'ok'},
    {id:'provider',status:'warn'}, {id:'docker',status:'ok'}, {id:'sandbox_image',status:'ok'},
  ]}).ready, true);
});

test('a healthy daemon cannot make an absent, failed or ambiguous sandbox image ready',()=>{
  const base=[{id:'node',status:'ok'},{id:'resources',status:'ok'},{id:'docker',status:'ok'}];
  for(const image of [[],[{id:'sandbox_image',status:'fail'}],[{id:'sandbox_image',status:'ok'},{id:'sandbox_image',status:'ok'}]]){
    const result=diagnostics.prerequisiteStatus({kind:'installed_user',checks:[...base,...image]});
    assert.equal(result.ready,false);
    assert.equal(result.sandboxImage,'unavailable');
  }
});

test('doctor failure names the platform launcher and keeps the Windows command', () => {
  assert.equal(diagnostics.runtimeDiagnosticsFailureMessage({platform: 'win32'}), 'Runtime diagnostics failed. Run Babel Harness.cmd doctor --json for local details.');
  assert.equal(diagnostics.runtimeDiagnosticsFailureMessage({platform: 'linux'}), 'Runtime diagnostics failed. Run babel-harness doctor --json for local details.');
  assert.match(diagnostics.runtimeDiagnosticsFailureMessage({killed: true, platform: 'linux'}), /timed out/);
});

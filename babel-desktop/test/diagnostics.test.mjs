import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as diagnostics from '../native/diagnostics.mjs';

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

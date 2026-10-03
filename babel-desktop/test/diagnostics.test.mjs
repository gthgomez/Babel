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

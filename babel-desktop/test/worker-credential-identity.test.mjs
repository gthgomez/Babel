import test from 'node:test';
import assert from 'node:assert/strict';
import {workerConnectionMatches} from '../native/session-profile.mjs';

test('a resident worker is replaced when the selected account key changes out of band',()=>{
  assert.equal(workerConnectionMatches('same-route','same-route','synthetic-first','synthetic-first'),true);
  assert.equal(workerConnectionMatches('same-route','same-route','synthetic-first','synthetic-second'),false);
  assert.equal(workerConnectionMatches('route-a','route-b','synthetic-first','synthetic-first'),false);
  assert.equal(workerConnectionMatches('same-route','same-route',null,'synthetic-first'),false);
});

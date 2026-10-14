import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProjectCredentialScope,applySelectedModelEnvironment} from '../native/childEnv.mjs';

test('auxiliary routes use provider IDs and cannot inherit another endpoint or critic model',()=>{
  const env=applySelectedModelEnvironment({BABEL_COMPACTION_MODEL:'saved-default',BABEL_DIFF_CRITIC_PRO_MODEL:'other',BABEL_COMPACTION_API_BASE:'https://other.invalid',BABEL_COMPACTION_API_KEY:'synthetic'},{id:'deepseek-v4-flash-openrouter',modelId:'deepseek/deepseek-v4-flash-0731'});
  for(const key of ['BABEL_COMPACTION_MODEL','BABEL_DIFF_CRITIC_MODEL','BABEL_DIFF_CRITIC_PRO_MODEL'])assert.equal(env[key],'deepseek/deepseek-v4-flash-0731');
  assert.equal(env.BABEL_COMPACTION_API_BASE,undefined);
  assert.equal(env.BABEL_COMPACTION_API_KEY,undefined);
});

test('an inherited project credential directory is always stripped from the CLI child',()=>{
  const env=applyProjectCredentialScope({PATH:'/bin',BABEL_PROJECT_CREDENTIALS_DIR:'/elsewhere'},{});
  assert.equal(env.BABEL_PROJECT_CREDENTIALS_DIR,undefined);
  assert.equal(env.PATH,'/bin');
});

test('project credentials are exposed only for an explicit same-project opt-in',()=>{
  const opted=applyProjectCredentialScope({},{projectCredentialRoot:'/projects/a',projectRoot:'/projects/a'});
  assert.equal(opted.BABEL_PROJECT_CREDENTIALS_DIR,'/projects/a');
});

test('a different selected project never inherits another project credentials',()=>{
  const env=applyProjectCredentialScope(
    {BABEL_PROJECT_CREDENTIALS_DIR:'/projects/a'},
    {projectCredentialRoot:'/projects/a',projectRoot:'/projects/b'},
  );
  assert.equal(env.BABEL_PROJECT_CREDENTIALS_DIR,undefined);
});

test('no selected project exposes no project credential directory',()=>{
  const env=applyProjectCredentialScope(
    {BABEL_PROJECT_CREDENTIALS_DIR:'/projects/a'},
    {projectCredentialRoot:'/projects/a',projectRoot:null},
  );
  assert.equal(env.BABEL_PROJECT_CREDENTIALS_DIR,undefined);
});

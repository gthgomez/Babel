import assert from 'node:assert/strict';
import test from 'node:test';
import {buildTaskContractV1,freezeTaskContract,validateTaskContractV1} from './taskContract.js';
import {reviseTaskMode,validateTaskModeHistory} from './taskModeRevision.js';

function objective(mode:'chat'|'plan'='chat'){
  return freezeTaskContract(buildTaskContractV1({task_id:'task:retained-objective',mode,user_request:'Fix the fixture and run the declared tests',goal:'Fix the fixture',task_class:'general_swe',acceptance:[{id:'required-tests',description:'The full declared suite passes',type:'unit_test',required:true,verification_strategy:'Run the fixture suite',verification:{kind:'unit_test',verifier_id:'fixture-suite',executable_id:'node',argv:['--test','fixture.test.mjs'],working_directory:'.',environment_policy:'isolated',artifact_expectations:['tap-summary']}}],non_goals:['Do not alter unrelated files'],allowed_paths:['fixture.mjs'],protected_paths:['fixture.test.mjs'],verifier_requirements:['node --test fixture.test.mjs'],allowed_effects:mode==='plan'?['read_only']:['read_only','reconcilable_mutation'],baseline_reproduction:'The declared fixture test fails',baseline_verifier_state:{command:'node --test fixture.test.mjs',exit_code:1,summary:'Fixture baseline failed'},max_turns:12,max_tokens:24000,base_sha:'fixture-base',risk:'medium'}));
}

test('Chat to Plan to Chat retains one objective and exact acceptance with immutable linked revisions',()=>{
  const original=objective(),originalBytes=JSON.stringify(original);
  const plan=reviseTaskMode(original,'plan',[original]);
  assert.equal(plan.contract.mode,'plan');assert.equal(plan.contract.task_id,original.task_id);
  assert.notEqual(plan.contract.contract_id,original.contract_id);assert.notEqual(plan.contract.contract_hash,original.contract_hash);
  assert.equal(plan.contract.provenance.parent_contract_id,original.contract_id);
  assert.deepEqual(plan.contract.allowed_effects,['read_only']);
  const chat=reviseTaskMode(plan.contract,'chat',plan.history);
  assert.equal(chat.contract.provenance.parent_contract_id,plan.contract.contract_id);
  for(const contract of [plan.contract,chat.contract]){
    assert.deepEqual(contract.acceptance,original.acceptance);assert.deepEqual(contract.verifier_requirements,original.verifier_requirements);
    assert.deepEqual(contract.budgets,original.budgets);assert.deepEqual(contract.authority,original.authority);
    assert.deepEqual(contract.scope,original.scope);assert.deepEqual(contract.protected_paths,original.protected_paths);
    assert.equal(contract.goal,original.goal);assert.equal(contract.user_request,original.user_request);
    assert.deepEqual(contract.baseline_verifier_state,original.baseline_verifier_state);
    assert.deepEqual(validateTaskContractV1(contract),[]);assert.equal(Object.isFrozen(contract),true);
  }
  assert.deepEqual(chat.contract.allowed_effects,original.allowed_effects);
  assert.equal(JSON.stringify(original),originalBytes);
  assert.deepEqual(validateTaskModeHistory(chat.contract,chat.history),[]);
  assert.equal(reviseTaskMode(chat.contract,'chat',chat.history).contract,chat.contract);
});

test('a Plan-only contract cannot obtain Chat execution authority from a mode selection',()=>{
  const plan=objective('plan');
  assert.throws(()=>reviseTaskMode(plan,'chat',[plan]),/MODE_EXECUTION_AUTHORITY_REQUIRED/);
  assert.throws(()=>reviseTaskMode(plan,'deep',[plan]),/MODE_UNSUPPORTED/);
  assert.deepEqual(plan.allowed_effects,['read_only']);
});

test('mode history refuses unrelated objectives, missing parents and modified authority ceilings',()=>{
  const original=objective(),plan=reviseTaskMode(original,'plan',[original]);
  const unrelated=freezeTaskContract(buildTaskContractV1({task_id:original.task_id,mode:'chat',user_request:'A different request',acceptance_criteria:['Unrelated acceptance']}));
  assert.notEqual(validateTaskModeHistory(plan.contract,[unrelated,plan.contract]).length,0);
  assert.notEqual(validateTaskModeHistory(plan.contract,[plan.contract]).length,0);
  assert.throws(()=>reviseTaskMode(plan.contract,'chat',[{...original,allowed_effects:['read_only']},plan.contract]),/MODE_HISTORY_INVALID/);
  assert.throws(()=>reviseTaskMode(plan.contract,'chat',[]),/MODE_HISTORY_INVALID/);
});

test('malformed runtime lineage and unsupported modes reject without deriving authority',()=>{
  const current=objective();
  assert.throws(()=>reviseTaskMode(current,'chat',[null as unknown as typeof current]),/MODE_HISTORY_INVALID/);
  assert.throws(()=>reviseTaskMode(current,'unexpected' as 'chat',[current]),/MODE_UNSUPPORTED/);
});

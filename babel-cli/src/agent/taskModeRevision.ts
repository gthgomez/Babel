import {sha256Canonical} from '../acceptance/canonical.js';
import type {BabelMode} from '../executor/contracts.js';
import {buildTaskContractV1,freezeTaskContract,validateTaskContractV1,OBJECTIVE_LIFECYCLE_REF,type TaskContractV1,type TaskContractProvenanceRecord} from './taskContract.js';
import {ACCEPTANCE_AMENDMENT_REF,validateTaskAcceptanceRevision,type TaskAcceptanceDescriptorV1,type TaskModeHistoryV2,type TaskRevisionEdgeV2} from './taskAcceptanceRevision.js';
import {ACCEPTANCE_MEANING_REF} from './taskAcceptanceMeaning.js';

/** Versioned companion to the frozen head; original execution ceiling is retained. */
export interface TaskModeHistoryV1 {schema_version:1;revisions:TaskContractV1[]}
export type TaskModeHistory = TaskModeHistoryV1 | TaskModeHistoryV2;
export const MODE_REVISION_HISTORY_REF='task-mode-history:v1';

/** Mode/effect policy may narrow a task; its objective and acceptance cannot drift. */
function objectiveDigest(contract:TaskContractV1):string{
  const {contract_id:_id,contract_hash:_hash,frozen:_frozen,mode:_mode,allowed_effects:_effects,created_at:_time,provenance:_provenance,...objective}=contract;
  return sha256Canonical(objective);
}

/** Validate the exact retained lineage before using an ancestor's effect ceiling. */
export function validateTaskModeHistory(current:TaskContractV1,history:readonly TaskContractV1[]):string[]{
  if(!Array.isArray(history)||history.length===0||history.length>1000)return ['history'];
  if(validateTaskContractV1(current).length)return ['current'];
  const errors:string[]=[],ids=new Set<string>();
  for(const [index,contract] of history.entries())if(validateTaskContractV1(contract).length||!contract.task_id)errors.push(`revision.${index}.contract`);
  if(errors.length)return errors;
  const root:TaskContractV1=history[0]!;
  for(const [index,contract] of history.entries()){
    if(ids.has(contract.contract_id))errors.push(`revision.${index}.duplicate`);
    ids.add(contract.contract_id);
    if(!['chat','plan'].includes(contract.mode))errors.push(`revision.${index}.mode`);
    if(objectiveDigest(contract)!==objectiveDigest(root))errors.push(`revision.${index}.objective`);
    if(index>0&&meaningDigest(contract)!==meaningDigest(history[index-1]!))errors.push(`revision.${index}.provenance`);
    if(index>0&&contract.provenance.parent_contract_id!==history[index-1]!.contract_id)errors.push(`revision.${index}.parent`);
    if(index>0&&!contract.provenance.records.some((record:TaskContractProvenanceRecord)=>record.kind==='risk_analysis'&&record.ref===MODE_REVISION_HISTORY_REF))errors.push(`revision.${index}.history_marker`);
    if(index===0&&contract.provenance.parent_contract_id)errors.push('root.parent');
    const effects=contract.mode==='plan'?root.allowed_effects.filter(effect=>effect==='read_only'):root.allowed_effects;
    if(JSON.stringify(contract.allowed_effects)!==JSON.stringify(effects))errors.push(`revision.${index}.effects`);
    if(root.mode==='plan'&&contract.mode!=='plan')errors.push(`revision.${index}.authority`);
  }
  const last=history.at(-1)!;
  if(last.contract_id!==current.contract_id||sha256Canonical(last)!==sha256Canonical(current))errors.push('head');
  return errors;
}

/** New frozen revision, never a replacement task or an inferred execution grant. */
export function reviseTaskMode(current:TaskContractV1,mode:BabelMode,history:readonly TaskContractV1[]):{contract:TaskContractV1;history:TaskContractV1[]}{
  if(mode!=='chat'&&mode!=='plan')throw new Error('MODE_UNSUPPORTED: This transition requires its real controller and an explicit authority handoff');
  if(validateTaskModeHistory(current,history).length)throw new Error('MODE_HISTORY_INVALID: Restore the matching contract lineage before changing modes');
  if(current.mode===mode)return {contract:current,history:[...history]};
  const ceiling=history[0]!;
  if(mode==='chat'&&ceiling.mode!=='chat')throw new Error('MODE_EXECUTION_AUTHORITY_REQUIRED: A Plan-only objective requires an explicit authorized implementation revision');
  const contract=buildModeContract(current,mode,ceiling);
  const next=[...history,contract];
  if(validateTaskModeHistory(contract,next).length)throw new Error('MODE_HISTORY_INVALID: The mode revision did not preserve its objective and authority');
  return {contract,history:next};
}

function buildModeContract(current:TaskContractV1,mode:'chat'|'plan',ceiling:TaskContractV1):TaskContractV1{
  return freezeTaskContract(buildTaskContractV1({
    task_id:current.task_id,mode,goal:current.goal,user_request:current.user_request,task_class:current.task_class,
    required_behaviors:current.required_behaviors,invariants:current.invariants,acceptance:current.acceptance,
    acceptance_criteria:current.acceptance_criteria,non_goals:current.non_goals,scope:current.scope,risk:current.risk,
    authority:current.authority,base_sha:current.base_sha,allowed_paths:current.allowed_paths,protected_paths:current.protected_paths,
    verifier_requirements:current.verifier_requirements,failure_class_budgets:current.budgets.failure_class_budgets,
    ...(current.budgets.max_turns!==undefined?{max_turns:current.budgets.max_turns}:{}),
    ...(current.budgets.max_tokens!==undefined?{max_tokens:current.budgets.max_tokens}:{}),
    ...(current.baseline_reproduction!==undefined?{baseline_reproduction:current.baseline_reproduction}:{}),
    ...(current.baseline_verifier_state!==undefined?{baseline_verifier_state:current.baseline_verifier_state}:{}),
    allowed_effects:mode==='plan'?ceiling.allowed_effects.filter(effect=>effect==='read_only'):ceiling.allowed_effects,
    allowed_terminal_outcomes:current.allowed_terminal_outcomes,
    provenance:[...current.provenance.records.filter(record=>!(record.kind==='user_goal'&&record.ref==='user_request')&&!(record.kind==='derived_acceptance'&&record.ref==='acceptance_criteria')&&record.ref!==MODE_REVISION_HISTORY_REF),{kind:'risk_analysis',ref:MODE_REVISION_HISTORY_REF}],
    source:'taskModeRevision',parent_contract_id:current.contract_id,
  }));
}

function amendmentRefs(contract:TaskContractV1):string[]{
  return [...new Set(contract.provenance.records.filter(record=>record.ref.startsWith(`${ACCEPTANCE_AMENDMENT_REF}:`)).map(record=>record.ref))].sort();
}

function retainsProvenance(previous:TaskContractV1,current:TaskContractV1):boolean{
  const retained=(contract:TaskContractV1)=>contract.provenance.records.filter(record=>
    !(record.kind==='user_goal'&&record.ref==='user_request')&&
    !(record.kind==='derived_acceptance'&&record.ref==='acceptance_criteria')&&record.ref!==MODE_REVISION_HISTORY_REF);
  const previousRecords=retained(previous);
  const initialSeal=current.mode===previous.mode&&current.provenance.source==='taskObjectiveLifecycle'&&
    !previousRecords.some(record=>record.kind==='risk_analysis'&&record.ref===OBJECTIVE_LIFECYCLE_REF);
  const expected=initialSeal?[...previousRecords,{kind:'risk_analysis',ref:OBJECTIVE_LIFECYCLE_REF}]:previousRecords;
  return sha256Canonical(retained(current))===sha256Canonical(expected);
}

function meaningDigest(contract:TaskContractV1):string{
  return sha256Canonical(contract.provenance.records.filter(record=>record.ref.startsWith(`${ACCEPTANCE_MEANING_REF}:`)));
}

/** V1 keeps its original strict semantics; V2 admits only typed, linked edges. */
export function validateTaskModeCompanion(current:TaskContractV1,history:TaskModeHistory):string[]{
  if(history?.schema_version===1)return validateTaskModeHistory(current,history.revisions);
  if(history?.schema_version!==2||!Array.isArray(history.revisions)||!history.revisions.length||history.revisions.length>100_000||
    !Array.isArray(history.edges)||history.edges.length!==history.revisions.length-1)return ['history'];
  const revisions=history.revisions,errors:string[]=[],ids=new Set<string>();
  if(validateTaskContractV1(current).length)return ['current'];
  for(const [index,contract] of revisions.entries()){
    if(validateTaskContractV1(contract).length||!contract.frozen||!contract.task_id)return [`revision.${index}.contract`];
  }
  const root=revisions[0]!;
  if(root.provenance.parent_contract_id)errors.push('root.parent');
  for(const [index,contract] of revisions.entries()){
    if(ids.has(contract.contract_id))errors.push(`revision.${index}.duplicate`);
    ids.add(contract.contract_id);
    if(contract.task_id!==root.task_id||!['chat','plan'].includes(contract.mode))errors.push(`revision.${index}.identity`);
    const effects=contract.mode==='plan'?root.allowed_effects.filter(effect=>effect==='read_only'):root.allowed_effects;
    if(sha256Canonical(contract.allowed_effects)!==sha256Canonical(effects)||root.mode==='plan'&&contract.mode!=='plan')errors.push(`revision.${index}.authority`);
    if(index===0)continue;
    const previous=revisions[index-1]!,edge=history.edges[index-1];
    if(!edge||edge.from_contract_id!==previous.contract_id||edge.to_contract_id!==contract.contract_id||contract.provenance.parent_contract_id!==previous.contract_id){errors.push(`revision.${index}.edge`);continue;}
    if(!contract.provenance.records.some(record=>record.kind==='risk_analysis'&&record.ref===MODE_REVISION_HISTORY_REF))errors.push(`revision.${index}.history_marker`);
    if(edge.kind==='mode'){
      if(objectiveDigest(previous)!==objectiveDigest(contract)||sha256Canonical(amendmentRefs(previous))!==sha256Canonical(amendmentRefs(contract)))errors.push(`revision.${index}.objective`);
      if(!retainsProvenance(previous,contract))errors.push(`revision.${index}.provenance`);
    }else if(edge.kind==='acceptance'){
      errors.push(...validateTaskAcceptanceRevision(previous,contract,edge.descriptor).map(error=>`revision.${index}.${error}`));
      const expected=[...new Set([...amendmentRefs(previous),`${ACCEPTANCE_AMENDMENT_REF}:${sha256Canonical(edge.descriptor)}`])].sort();
      if(sha256Canonical(expected)!==sha256Canonical(amendmentRefs(contract)))errors.push(`revision.${index}.markers`);
    }else errors.push(`revision.${index}.kind`);
  }
  if(sha256Canonical(revisions.at(-1))!==sha256Canonical(current))errors.push('head');
  return errors;
}

/** Append one explicit semantic edge without changing any retained revision. */
export function appendTaskAcceptanceRevision(history:TaskModeHistory,contract:TaskContractV1,descriptor:TaskAcceptanceDescriptorV1):TaskModeHistoryV2{
  const previous=history.revisions.at(-1)!;
  if(validateTaskModeCompanion(previous,history).length)throw new Error('MODE_HISTORY_INVALID');
  const priorEdges:TaskRevisionEdgeV2[]=history.schema_version===2?[...history.edges]:history.revisions.slice(1).map((item,index)=>({kind:'mode',from_contract_id:history.revisions[index]!.contract_id,to_contract_id:item.contract_id}));
  const next:TaskModeHistoryV2={...history,schema_version:2,revisions:[...history.revisions,contract],edges:[...priorEdges,{kind:'acceptance',from_contract_id:previous.contract_id,to_contract_id:contract.contract_id,descriptor}]};
  const errors=validateTaskModeCompanion(contract,next);
  if(errors.length)throw new Error(`MODE_HISTORY_INVALID: ${errors.join(', ')}`);
  return next;
}

/** Mode-only selection retains V2 acceptance edges and the original ceiling. */
export function reviseTaskModeCompanion(current:TaskContractV1,mode:BabelMode,history:TaskModeHistory):{contract:TaskContractV1;history:TaskModeHistory}{
  if(history.schema_version===1){const revised=reviseTaskMode(current,mode,history.revisions);return {contract:revised.contract,history:{...history,revisions:revised.history}};}
  if(mode!=='chat'&&mode!=='plan')throw new Error('MODE_UNSUPPORTED: This transition requires its real controller and an explicit authority handoff');
  if(validateTaskModeCompanion(current,history).length)throw new Error('MODE_HISTORY_INVALID');
  if(current.mode===mode)return {contract:current,history};
  const ceiling=history.revisions[0]!;
  if(mode==='chat'&&ceiling.mode!=='chat')throw new Error('MODE_EXECUTION_AUTHORITY_REQUIRED: A Plan-only objective requires an explicit authorized implementation revision');
  const contract=buildModeContract(current,mode,ceiling);
  const next:TaskModeHistoryV2={...history,revisions:[...history.revisions,contract],edges:[...history.edges,{kind:'mode',from_contract_id:current.contract_id,to_contract_id:contract.contract_id}]};
  if(validateTaskModeCompanion(contract,next).length)throw new Error('MODE_HISTORY_INVALID');
  return {contract,history:next};
}

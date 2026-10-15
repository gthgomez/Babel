import {presentTool, statusFromTerminalOutcome} from '../src/core.mjs';

const bounded=(value,max=200)=>typeof value==='string'&&value.length<=max?value:undefined;

/** One retained record. No ordinal-to-turn mapping or inferred completion. */
export function parseArchiveRecord(line) {
  if(!line.trim())return null;
  let value;
  try{value=JSON.parse(line);}catch{return null;}
  if(!value||typeof value!=='object'||typeof value.content!=='string')return null;
  const canonical=value.archive_source==='thread_events';
  const toolCalls=canonical&&value.archive_kind==='assistant_tool_calls'&&value.role==='assistant'&&Array.isArray(value.tool_calls);
  const toolResult=canonical&&value.archive_kind==='tool_result'&&value.role==='tool'&&typeof value.tool_call_id==='string';
  if(value.role!=='user'&&value.role!=='assistant'&&!toolResult)return null;
  if(toolCalls){
    const argumentsText=value.tool_calls.filter(call=>typeof call?.function?.name==='string'&&typeof call?.function?.arguments==='string')
      .map(call=>`${call.function.name} ${call.function.arguments}`).join('\n');
    return {...value,assistantText:value.content,content:[value.content,argumentsText].filter(Boolean).join('\n')};
  }
  return value.content.trim()||toolResult?value:null;
}

function archiveTools(value) {
  if(value.archive_source!=='thread_events')return [];
  if(value.archive_kind==='assistant_tool_calls'&&Array.isArray(value.tool_calls))return value.tool_calls.slice(0,100).flatMap(call=>{
    if(!bounded(call?.id)||!bounded(call?.function?.name)||typeof call?.function?.arguments!=='string')return [];
    let target=call.function.name;
    try{const args=JSON.parse(call.function.arguments);target=[args?.path,args?.command,args?.query].find(item=>typeof item==='string')??target;}catch{/* Keep the exact arguments as read-only detail. */}
    return [{id:`${value.source_event_id}:${call.id}`,toolCallId:call.id,...presentTool(call.function.name,target.slice(0,500)),status:'unverified',meta:'Proposed · result in separate entry',detail:call.function.arguments.slice(0,4000)}];
  });
  if(value.archive_kind==='tool_result'&&bounded(value.tool_call_id))return [{
    id:`${value.source_event_id}:${value.tool_call_id}`,toolCallId:value.tool_call_id,
    ...presentTool(bounded(value.name)??'tool',bounded(value.name)??'tool'),
    status:Number.isInteger(value.exit_code)?value.exit_code===0?'complete':'failed':'unverified',
    meta:Number.isInteger(value.exit_code)?`Exit ${value.exit_code}`:'Exit status unknown',detail:value.content.slice(0,4000),
  }];
  return [];
}

export function projectArchiveMessage(value) {
  const canonical=value.archive_source==='thread_events';
  const context=canonical&&(value.name==='working_state'||value.name==='harness_feedback'||value.name==='intent_plan');
  const candidate=canonical&&value.archive_kind==='model_candidate';
  const tools=archiveTools(value);
  const activity=context?{kind:'context',label:'Retained context'}:candidate?{kind:'model_candidate',label:'Model response before controller completion'}:tools.length?{kind:'tools',label:'Retained tool activity'}:null;
  const outcome=typeof value.terminal_outcome==='string'?value.terminal_outcome:typeof value.outcome==='string'?value.outcome:null;
  const text=value.content.slice(0,250000);
  const route=canonical&&value.route?.source==='turn_started'&&bounded(value.route.provider,128)&&bounded(value.route.model,256)
    ? {provider:value.route.provider,model:value.route.model,source:'turn_started'}:undefined;
  return {
    role:activity?'assistant':value.role,text,textTruncated:value.content.length>text.length,
    historyDetail:canonical?'canonical':'legacy',tools,activity,
    ...(tools.length?{fullActivityAvailable:true,...(typeof value.assistantText==='string'?{assistantText:value.assistantText.slice(0,250000)}:{})}:{}),
    ...(bounded(value.source_event_id)?{sourceEventId:value.source_event_id}:{}),
    ...(bounded(value.item_id)?{itemId:value.item_id}:{}),
    ...(bounded(value.thread_id)?{threadId:value.thread_id}:{}),
    ...(value.turn_id!==undefined&&value.turn_id!==null?{turn_id:value.turn_id}:{}),
    ...(route?{route}:{}),
    ...(canonical?{archive_kind:value.archive_kind}:{}),
    ...(outcome?{terminalOutcome:outcome}:{}),
    ...(activity?{status:null}:value.role==='assistant'?{status:outcome?statusFromTerminalOutcome(outcome):'unverified'}:{}),
    ...(Array.isArray(value.tool_calls)&&value.tool_calls.length>100?{toolsTruncated:true}:{}),
  };
}

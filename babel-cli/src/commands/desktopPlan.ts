import {makeRunStreamEvent,writeNdjson} from '../cli/structuredOutput.js';
import type {LiteToolStreamSink} from '../ui/liteToolStream.js';

export type DesktopPlanOptions = {
  project?: string;
  projectRoot?: string;
  model?: string;
  executionProfile?: string;
  json?: boolean;
  onResult?: (payload: Record<string,unknown>,humanText?: string)=>void;
  toolStream?: LiteToolStreamSink;
};

/** Transport adapter to the same read-only controller used by `babel plan`.
 * Calling the plan lane directly deliberately excludes saved auto-application.
 * The caller must complete ordinary run/model/profile admission first.
 */
export async function runDesktopPlan(
  task: string,
  options: DesktopPlanOptions,
  execute: (verb:'plan',parts:string[],options:DesktopPlanOptions)=>Promise<unknown>,
): Promise<void> {
  writeNdjson(makeRunStreamEvent('run_start',{mode:'plan',model:options.model??'default'}));
  const tools=new Map<string,string>();let sequence=0;let resultEmitted=false;
  try {
    await execute('plan',[task],{...options,json:true,toolStream:{emit(event){
      const key=JSON.stringify([event.tool,event.target]);
      const id=event.status==='running'?`plan:${++sequence}`:tools.get(key)??`plan:${++sequence}`;
      if(event.status==='running')tools.set(key,id);else tools.delete(key);
      const type=event.status==='running'?'tool.started':event.status==='pass'?'tool.completed':'tool.failed';
      writeNdjson(makeRunStreamEvent(type,{item:{id,tool:event.tool,target:event.target,detail:event.detail??event.status}}));
    }},onResult:(payload,humanText)=>{
      resultEmitted=true;
      const answer=payload['answer'];
      const result=humanText?{...payload,answer:{...(answer&&typeof answer==='object'?answer:{}),answer:humanText}}:payload;
      writeNdjson(makeRunStreamEvent('run_complete',{result}));
    }});
    if(!resultEmitted)throw new Error('The read-only plan controller returned without a result.');
  } catch(error:unknown) {
    const message=error instanceof Error?error.message:String(error);
    writeNdjson(makeRunStreamEvent('run_error',{error:message,status:'EXECUTOR_HALTED'}));
    process.exitCode=1;
  }
}

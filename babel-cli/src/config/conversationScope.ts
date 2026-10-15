/** Bootstrap may narrow authority before Commander loads provider credentials. */
export function conversationScopeRequested(argv:readonly string[]):boolean {
  const end=argv.indexOf('--')
  const flags=end<0?argv:argv.slice(0,end)
  return flags.some((arg,index)=>arg==='--execution-scope=conversation'||(arg==='--execution-scope'&&flags[index+1]==='conversation'))
}

export function resolveRunScope(options:{
  executionScope?:string;mode?:string;project?:string;projectRoot?:string;
  useChatPipeline?:boolean;executionProfile?:string;orchestrator?:string;
  sessionId?:string;sessionStartPath?:string;localLearningRoot?:string;
},env:NodeJS.ProcessEnv=process.env):'conversation'|'project' {
  if(options.executionScope===undefined||options.executionScope==='project')return 'project'
  if(options.executionScope!=='conversation')throw new Error('Invalid execution scope. Use project or conversation.')
  if(!['chat','chat-headless'].includes(options.mode??'chat')||options.useChatPipeline||env['BABEL_LITE_WORKER_CHAIN']==='1')throw new Error('Conversation scope requires the ChatEngine chat controller.')
  if(options.project!==undefined||options.projectRoot!==undefined||options.sessionId!==undefined||options.sessionStartPath!==undefined||options.localLearningRoot!==undefined||options.orchestrator!==undefined)throw new Error('Conversation scope cannot be combined with project or pipeline bindings.')
  if(options.executionProfile!==undefined&&options.executionProfile!=='safe_repo')throw new Error('Conversation scope does not admit a project execution profile.')
  return 'conversation'
}

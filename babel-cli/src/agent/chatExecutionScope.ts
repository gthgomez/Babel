import {isAbsolute,resolve} from 'node:path'

/** A conversation grants no project effects. Legacy absolute roots remain project scope. */
export type ChatExecutionScope = {kind:'conversation'} | {kind:'project';projectRoot:string}

export interface ChatScopeInput {
  executionScope?: ChatExecutionScope | undefined
  projectRoot?: string | null | undefined
}

/** Resolve host scope without consulting cwd, environment or filesystem defaults. */
export function normalizeChatExecutionScope(input:ChatScopeInput):ChatExecutionScope {
  const scope=input.executionScope
  if(scope?.kind==='conversation'){
    if(input.projectRoot!==undefined&&input.projectRoot!==null)throw new Error('Conflicting conversation and project scope')
    return {kind:'conversation'}
  }
  if(scope!==undefined&&scope.kind!=='project')throw new Error('Invalid execution scope')
  const root=scope?.projectRoot??input.projectRoot
  if(typeof root!=='string'||!isAbsolute(root)||root.includes('\0'))throw new Error('An explicit conversation scope or absolute project root is required')
  const normalized=resolve(root)
  if(scope&&input.projectRoot!==undefined){
    if(typeof input.projectRoot!=='string'||!isAbsolute(input.projectRoot)||input.projectRoot.includes('\0'))throw new Error('Conflicting project scope roots')
    const paired=resolve(input.projectRoot)
    if(process.platform==='win32'?paired.toLowerCase()!==normalized.toLowerCase():paired!==normalized)throw new Error('Conflicting project scope roots')
  }
  return {kind:'project',projectRoot:root}
}

/** Project-only paths fail closed, even when ambient cwd/environment has a root. */
export function requireProjectRoot(input:ChatScopeInput):string {
  const scope=normalizeChatExecutionScope(input)
  if(scope.kind==='conversation')throw new Error('PROJECT_REQUIRED: Select and authorize a project before using project tools')
  return scope.projectRoot
}

/** Legacy missing identity is unknown; it is never a confirmed conversation scope. */
export function assertConversationRestoreScope(log:{events:readonly unknown[]}|null,input:ChatScopeInput):void {
  if(normalizeChatExecutionScope(input).kind!=='conversation')return
  const turns=log?.events.filter((event):event is Record<string,unknown>=>typeof event==='object'&&event!==null&&'kind' in event&&event.kind==='turn_started')??[]
  if(turns.length===0||turns.some(turn=>turn.projectRoot!==null||typeof turn.executionScope!=='object'||turn.executionScope===null||!('kind' in turn.executionScope)||turn.executionScope.kind!=='conversation'))throw new Error('SESSION_SCOPE_UNKNOWN: This archive is not proven conversation-only; explicit project rebind is required')
}

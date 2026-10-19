/** Pure renderer/transport utilities. No Babel runtime behavior lives here. */
export function hydrateArchivedMessage(message) {
  const base={...message,archiveIndex:message.messageIndex};
  if(message.role==='user'&&!message.activity)return base;
  const tools=Array.isArray(message.tools)?message.tools:[];
  const blocks=message.activity?.kind==='context'||message.activity?.kind==='model_candidate'
    ? [{kind:'note',label:message.activity.label,text:message.text}]
    : [...(message.activity?.kind==='tools'?(message.assistantText?[{kind:'text',text:message.assistantText}]:[]):[{kind:'text',text:message.text}]),...tools.map(tool=>({kind:'tool',tool}))];
  return {...base,role:'assistant',status:message.activity?null:message.status??'unverified',tools,blocks};
}
export function isConversationOnlyConnection(info) {
  return info?.projectRoot===null&&info?.projectAuthority?.scope==='conversation'&&info.projectAuthority.identity===null&&info.projectAuthority.trusted===false;
}
export function modeUnavailableReason(mode, provider,scope='project') {
  if (mode === 'chat') return '';
  if(scope==='conversation')return 'Select and authorize a project before using Plan or Deep.';
  if (!provider) return 'Choose a provider first.';
  return provider === 'openrouter' ? '' : 'Plan and Deep currently require OpenRouter. Use Chat with this provider.';
}
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function contextPercent(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.round(Math.min(100, Math.max(0, used / limit * 100)));
}
export function safeProjectPath(value) {
  const path = String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || path.length > 2048 || path.includes('\0') || path.split('/').some(part => !part || part === '..')) return '';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return '';
  return path;
}
export function rememberChange(list, path, additions, deletions) {
  const safe = safeProjectPath(path);
  const next = Array.isArray(list) ? list.slice() : [];
  if (!safe) return next;
  const adds = Number.isFinite(additions) ? additions : null;
  const dels = Number.isFinite(deletions) ? deletions : null;
  const found = next.find(item => item.path === safe);
  if (found) {
    if (adds != null) found.additions = (found.additions ?? 0) + adds;
    if (dels != null) found.deletions = (found.deletions ?? 0) + dels;
    return next;
  }
  if (next.length >= 100) return next;
  next.push({ path: safe, additions: adds, deletions: dels });
  return next;
}
export function sessionIdFromResult(result) {
  const id = result?.session_id;
  return typeof id === 'string' && /^[\w-]{1,80}$/.test(id) ? id : '';
}
/** Versioned operation identity from the CLI; legacy approvals stay read-only. */
export function scopedApproval(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schemaVersion!==2)return null;
  for(const field of ['request_id','thread_id','turn_id'])if(typeof value[field]!=='string'||! /^[\w.:-]{1,200}$/.test(value[field]))return null;
  if(typeof value.run_id!=='string'||! /^[\w-]{1,100}$/.test(value.run_id)||
    typeof value.operation_digest!=='string'||! /^[a-f0-9]{64}$/.test(value.operation_digest)||
    typeof value.expires_at!=='string'||value.expires_at.length>40||!Number.isFinite(Date.parse(value.expires_at)))return null;
  return {schemaVersion:2,request_id:value.request_id,thread_id:value.thread_id,turn_id:value.turn_id,
    operation_digest:value.operation_digest,run_id:value.run_id,expires_at:value.expires_at};
}
export function scopedApprovalReply(value,expected,now=Date.now()) {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const actual=scopedApproval(value?.approval),binding=scopedApproval(expected);
  if(!actual||!binding||!['allow_once','deny'].includes(value.decision)||!Number.isFinite(now)||now>=Date.parse(binding.expires_at))return null;
  if(!Object.keys(binding).every(key=>actual[key]===binding[key]))return null;
  return {decision:value.decision,approval:actual};
}
export function presentTool(tool, target) {
  const name = String(tool ?? '').toLowerCase();
  const path = String(target ?? tool ?? 'tool');
  let action = 'run';
  if (/search|grep|glob/.test(name)) action = 'search';
  else if (/read|list|directory/.test(name)) action = 'read';
  else if (/write|edit|patch|replace|str_replace/.test(name)) action = 'edit';
  else if (/test/.test(name)) action = 'run';
  return { action, path, label: `${action} ${path}` };
}
function sameWork(left, right) {
  return left?.action === right?.action && left?.path === right?.path;
}
export function absorbFileChange(tools, item) {
  const path = safeProjectPath(item?.path);
  if (!path) return null;
  const meta = `+${Number(item.additions) || 0} -${Number(item.deletions) || 0}`;
  const existing = (Array.isArray(tools) ? tools : []).find(tool => tool.action === 'edit' && tool.path === path);
  if (existing) {
    existing.meta = meta;
    // A changed file proves a change was observed, not that its tool finished.
    return existing;
  }
  return { id: `file:${path}`, action: 'edit', path, label: `edit ${path}`, status: 'complete', detail: '', meta };
}
export function reviewFromResult(result) {
  const critic = result?.critic_receipt;
  const reasons = Array.isArray(critic?.reasons)
    ? critic.reasons.filter(reason => typeof reason === 'string' && reason.trim()).map(reason => reason.trim().slice(0, 500)).slice(0, 8)
    : [];
  if (!reasons.length) return null;
  const verdict = typeof critic.verdict === 'string' ? critic.verdict.trim().slice(0, 40) : '';
  return { title: verdict ? `REVIEW · ${verdict}` : 'REVIEW', reasons };
}
export function liveModelFromResult(result) {
  const context = result?.active_context;
  if (!context || context.source === 'unknown') return '';
  const id = typeof context.model_id === 'string' ? context.model_id.trim() : '';
  if (!id || id === 'unknown' || id === 'default') return '';
  return id.slice(0, 80);
}
export function liveRequestTokens(result) {
  const context = result?.active_context;
  if (!context || context.source !== 'provider_prompt_tokens') return null;
  const tokens = Number(context.tokens);
  if (!Number.isFinite(tokens) || tokens < 0) return null;
  return tokens;
}
export function toolsFromResult(result, existing) {
  const have = Array.isArray(existing) ? existing.slice() : [];
  const rows = [];
  const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const presented = presentTool(call.tool, call.target);
    const row = {
      id: String(call.toolCallId || `${presented.action}:${presented.path}`),
      ...presented,
      status: (typeof call.error === 'string' && call.error) || (Number.isInteger(call.exit_code) && call.exit_code !== 0) ? 'failed' : 'complete',
      detail: String(call.detail || call.error || '').slice(0, 4000),
      meta: '',
    };
    const previous = have.find(tool => tool.id === row.id);
    if (previous && ['complete','failed'].includes(previous.status)) continue;
    // Legacy records without IDs can only be matched by their displayed work.
    if (!call.toolCallId && have.some(tool => sameWork(tool, row))) continue;
    if (have.length + rows.length >= 100) break;
    rows.push(row);
    have.push(row);
  }
  const verifier = result?.verifier_receipt;
  const command = typeof verifier?.command === 'string' ? verifier.command.trim() : '';
  if (command) {
    const row = {
      id: `verify:${command}`.slice(0, 300),
      action: 'run',
      path: command.slice(0, 500),
      label: `run ${command}`.slice(0, 520),
      status: verifier.exit_code === 0 ? 'complete' : Number.isInteger(verifier.exit_code) ? 'failed' : 'unverified',
      detail: typeof verifier.summary === 'string' ? verifier.summary.slice(0, 4000) : '',
      meta: Number.isInteger(verifier.exit_code) ? `exit ${verifier.exit_code}` : '',
    };
    if (!have.some(tool => tool.id === row.id || sameWork(tool, row)) && have.length + rows.length < 100) rows.push(row);
  }
  return rows;
}
export function verifiedStatus(status, poisoned) {
  if (poisoned && status === 'complete') return 'unverified';
  return status;
}
/** Map authoritative Babel terminal outcomes to Desktop message status (unknown → unverified). */
export function statusFromTerminalOutcome(outcome) {
  if (typeof outcome !== 'string' || !outcome.trim()) return 'unverified';
  const states = {
    VERIFIED_COMPLETE: 'complete',
    NO_CHANGE_REQUIRED: 'no_change',
    UNVERIFIED_PATCH: 'unverified',
    CANCELLED: 'cancelled',
    BLOCKED_EXTERNAL: 'blocked',
    BLOCKED_POLICY: 'blocked',
    NEEDS_HUMAN_DECISION: 'blocked',
    INVALID_TASK: 'blocked',
    BUDGET_EXHAUSTED: 'failed',
    AGENT_FAILURE: 'failed',
    INFRA_FAILURE: 'failed',
  };
  return states[outcome] ?? 'unverified';
}
export function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return {kind:'unknown'};
  if (event.type === 'assistant_chunk' && typeof event.chunk === 'string') return {kind:'delta',text:event.chunk};
  if (event.type === 'thought' && typeof event.line === 'string') return {kind:'thought',text:event.line};
  if (event.type === 'run_start' || event.type === 'turn.started') return {kind:'start', model: typeof event.model === 'string' ? event.model : ''};
  if (event.type === 'approval.required') {
    const item=event.item ?? {};
    const bounded=value=>typeof value==='string'&&value.length<=250000&&!value.includes('\0')?value:'';
    return {kind:'approval', text:String(event.message ?? 'Babel is waiting for approval.'), command:bounded(item.command), cwd:bounded(item.cwd), details:bounded(item.details), approval:scopedApproval(item.approval), raw:event};
  }
  if (event.type === 'approval.pending' || event.type === 'approval.reconciled') {
    const item=event.item ?? {};
    const binding=scopedApproval(item.approval);
    const bounded=value=>typeof value==='string'&&value.length<=250000&&!value.includes('\0')?value:'';
    const command=bounded(item.command)||bounded(item.approval?.command);
    const cwd=bounded(item.cwd)||bounded(item.approval?.cwd);
    const details=bounded(item.details)||bounded(item.approval?.reason);
    return {kind:'approval', text:String(event.message ?? 'Approval is still pending on the shared protocol host.'), command, cwd, details, approval:binding, raw:event, reconciled:event.type==='approval.reconciled'};
  }
  if (event.type === 'control.rejected') {
    return {kind:'control', text:String(event.error ?? 'Control request was rejected.'), operation:String(event.operation ?? 'control'), raw:event};
  }
  if (event.type === 'transport.disconnected') {
    return {kind:'transport', text:String(event.message ?? 'Transport disconnected.'), recoverable:event.recoverable===true, raw:event};
  }
  if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
    const item = event.item ?? {};
    const presented = presentTool(item.tool, item.target);
    const failed = event.type === 'tool.failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0);
    const status = event.type === 'tool.started' ? 'running' : failed ? 'failed' : 'complete';
    const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
    const meta = status === 'running' ? 'running...' : exitCode == null ? '' : `exit ${exitCode}`;
    return {kind:'tool', id:String(item.id || `${presented.action}:${presented.path}`), action:presented.action, path:presented.path, label:presented.label, status, detail:typeof item.detail === 'string' ? item.detail : '', meta};
  }
  if (event.type === 'file.changed') {
    const item = event.item ?? {};
    const path = String(item.path ?? 'file');
    return {kind:'tool', id:`file:${path}`, action:'edit', path, label:`edit ${path}`, status:'complete', detail:'', meta:`+${Number(item.additions) || 0} -${Number(item.deletions) || 0}`};
  }
  if (event.type === 'cancelled') return {kind:'terminal', status:'cancelled', text:'', raw:event};
  if (event.type === 'run_error' || event.type === 'turn.failed') return {kind:'terminal',status:'failed',text:String(event.error ?? event.message ?? 'Babel reported a failure.'),raw:event};
  if (event.type === 'run_complete' || event.type === 'turn.completed') {
    const result = event.result ?? {};
    const outcome = result.terminal_outcome ?? result.outcome ?? '';
    // Mirrors cli/userFacingStatus.ts at blob b7cf206; unknown outcomes never pass.
    let status = statusFromTerminalOutcome(outcome);
    if (result.user_status === 'blocked' || result.approval_required === true) status = 'blocked';
    if (result.user_status === 'failed' || result.verification?.status === 'failed') status = 'failed';
    let text = [result.answer?.answer, result.answer, result.summary, result.response, result.output].find(v => typeof v === 'string') ?? '';
    const usage = result.usage && typeof result.usage === 'object' ? result.usage : null;
    return {kind:'terminal',status,text,raw:result,usage};
  }
  if (event.type === 'command.started' || event.type === 'command.completed') {
    const item = event.item ?? {};
    const command = String(item.command ?? item.name ?? 'command');
    const status = event.type === 'command.started' ? 'running' : item.exit_code === 0 ? 'complete' : Number.isInteger(item.exit_code) ? 'failed' : 'unverified';
    return {kind:'tool', id:String(item.id ?? command), action:'run', path:command, label:`run ${command}`, status, detail:typeof item.output === 'string' ? item.output : '', meta:status === 'running' ? 'running...' : ''};
  }
  if (event.type === 'stage' && typeof event.stage_name === 'string') return {kind:'progress', text:event.stage_name};
  if (event.type === 'progress' || event.type === 'log') return {kind:'progress',text:String(event.message ?? event.line ?? '')};
  return {kind:'unknown'};
}
export function validPreview(value) {
  if (!value || value.version !== 1 || !['chat','plan','deep'].includes(value.mode)) return false;
  if (!Array.isArray(value.sessions) || value.sessions.length < 1 || value.sessions.length > 60) return false;
  const ids = new Set();
  for (const s of value.sessions) {
    if (!s || typeof s.id !== 'string' || typeof s.title !== 'string' || s.title.length > 300 || !Array.isArray(s.messages) || s.messages.length > 150) return false;
    if (ids.has(s.id)) return false;
    ids.add(s.id);
    for (const m of s.messages) {
      if (!m || !['user','assistant'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 250000) return false;
      if (m.tools != null && (!Array.isArray(m.tools) || m.tools.length > 100 || !m.tools.every(t => t && typeof t.label === 'string' && typeof t.id === 'string' && typeof t.status === 'string'))) return false;
    }
  }
  return ids.has(value.activeId);
}

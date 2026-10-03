/** Pure renderer/transport utilities. No Babel runtime behavior lives here. */
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
export function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return {kind:'unknown'};
  if (event.type === 'assistant_chunk' && typeof event.chunk === 'string') return {kind:'delta',text:event.chunk};
  if (event.type === 'thought' && typeof event.line === 'string') return {kind:'thought',text:event.line};
  if (event.type === 'run_start' || event.type === 'turn.started') return {kind:'start', model: typeof event.model === 'string' ? event.model : ''};
  if (event.type === 'approval.required') return {kind:'approval', text:String(event.message ?? 'Babel is waiting for approval.'), raw:event};
  if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
    const item = event.item ?? {};
    const presented = presentTool(item.tool, item.target);
    const failed = event.type === 'tool.failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0);
    const status = event.type === 'tool.started' ? 'running' : failed ? 'failed' : 'complete';
    return {kind:'tool', id:String(item.id || `${presented.action}:${presented.path}`), action:presented.action, path:presented.path, label:presented.label, status, detail:typeof item.detail === 'string' ? item.detail : '', meta:status === 'running' ? 'running...' : ''};
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
    const states = {VERIFIED_COMPLETE:'complete',NO_CHANGE_REQUIRED:'no_change',UNVERIFIED_PATCH:'unverified',CANCELLED:'cancelled',BLOCKED_EXTERNAL:'blocked',BLOCKED_POLICY:'blocked',NEEDS_HUMAN_DECISION:'blocked',INVALID_TASK:'blocked',BUDGET_EXHAUSTED:'failed',AGENT_FAILURE:'failed',INFRA_FAILURE:'failed'};
    let status = states[outcome] ?? 'unverified';
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

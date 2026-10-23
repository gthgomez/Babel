import { escapeHtml, contextPercent, normalizeEvent, rememberChange, sessionIdFromResult, absorbFileChange, reviewFromResult, liveModelFromResult, liveRequestTokens, toolsFromResult, verifiedStatus, modeUnavailableReason,isConversationOnlyConnection,hydrateArchivedMessage } from './core.mjs';
import { icon } from './icons.mjs';
const MODE_OPTIONS=[{id:'chat',label:'Chat',description:'Coding tasks'},{id:'plan',label:'Plan',description:'Read-only planning'},{id:'deep',label:'Deep',description:'Governed workflow'}];

const LOGO = '__LOGO__';
const native = window.babelDesktop;
const $ = selector => document.querySelector(selector);
const e = escapeHtml;
let state={version:1,mode:'chat',model:'',sessions:[{id:'new',title:'New session',messages:[]}],activeId:'new'};
const transport='live';
let showAllSessions = false;
let sessionsVisibleLimit = 8;
let expandedFolders = new Set(['.']);
let expandedTools = new Set();
let activeFile = '';
let files = [];
let projectName = 'No project';

let activeRun = null;
let toastTimer;
let focusBeforeDialog = null;
let nativeInfo = null;
function modeBlockReason(mode,provider){return modeUnavailableReason(mode,provider,isConversationOnlyConnection(nativeInfo)?'conversation':'project');}
let connectionError = '';
let connecting = false;
let projectSwitching=false;
let sandboxBusy = false;
let sandboxStatus = '';
let connectionInitialized = false;
let connectedProjectRoot;
let liveModel = '';
let liveTokens = null;
let changedFiles = [];
let updatePhase = '';
let savedSessionList = {offset: 0, total: 0, limit: 30};
let configuredRouteLabel = '';
let configuredRoute = null;
let providerCatalog = [];
let composerDraftState=null;
let composerDraftWrite=null;
let composerDraftPending=null;
let composerDraftFailure=false;
const id = () => crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const activeSession = () => state.sessions.find(s => s.id === state.activeId) ?? state.sessions[0];

function captureComposerDraft(){
  const session=activeSession(),input=$('#composer-input');
  if(session&&input){session.draft=input.value;session.scrollTop=$('#conversation')?.scrollTop??0;}
}
function draftSnapshot(){
  return state.sessions.filter(session=>session.draft||session.pendingDraft||session.scrollTop>0||session.historyOffset>0).map(session=>({id:session.id,sessionId:session.babelSessionId??null,title:session.title.slice(0,80),text:session.draft||session.pendingDraft||'',scrollTop:session.scrollTop??0,historyOffset:session.history?.olderOffset??session.historyOffset??0}));
}
function persist(capture=true){
  if(capture)captureComposerDraft();
  if(!composerDraftState||composerDraftState.readOnly||!native?.writeComposerDrafts)return;
  composerDraftPending=draftSnapshot();
  void flushComposerDrafts();
}
async function flushComposerDrafts(){
  if(!composerDraftState&&native?.writeComposerDrafts&&state.sessions.some(session=>session.draft||session.pendingDraft))return false;
  if(composerDraftWrite)return composerDraftWrite;
  if(!composerDraftPending)return !composerDraftFailure;
  composerDraftWrite=(async()=>{
    while(composerDraftPending){
      const drafts=composerDraftPending;composerDraftPending=null;
      try{
        const result=await native.writeComposerDrafts({scope:composerDraftState.scope,revision:composerDraftState.revision,drafts});
        composerDraftState.revision=result.revision;composerDraftFailure=false;
      }catch{
        composerDraftFailure=true;
        toast('Draft saving failed. Keep this window open and copy your text before reopening Babel.');
        return false;
      }
    }
    return true;
  })();
  try{return await composerDraftWrite;}finally{composerDraftWrite=null;}
}
function selectSession(session){
  captureComposerDraft();state.activeId=session.id;
  $('#composer-input').value=session.draft??'';resizeComposer();
}
function positionToast() {
  const composer=$('.composer');
  if(composer)$('#toast').style.bottom=`${Math.max(12,window.innerHeight-composer.getBoundingClientRect().top+12)}px`;
}
function toast(message) {
  const target = $('#toast');
  target.textContent = message;
  positionToast();
  target.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => target.classList.remove('visible'), 4000);
}
function announce(message) { $('#live-announcement').textContent = message; }
function setMode(mode) {
  if (!MODE_OPTIONS.some(m => m.id === mode)) return;
  const unavailable = modeBlockReason(mode, configuredRoute?.provider);
  if (unavailable) { toast(unavailable); return; }
  if (activeRun) { toast('Wait for the active response before changing modes.'); return; }
  state.mode = mode; persist(); renderControls();
  announce(`${mode} mode selected.`);
}
function renderTabs() {
  $('#top-tabs').innerHTML = MODE_OPTIONS.map(m => `<button class="top-tab ${state.mode === m.id ? 'active' : ''}" data-action="mode" data-mode="${m.id}" aria-pressed="${state.mode === m.id}" ${activeRun || modeBlockReason(m.id,configuredRoute?.provider) ? 'disabled' : ''} title="${e(modeBlockReason(m.id,configuredRoute?.provider) || `${m.label} · ${m.description} (Alt+${MODE_OPTIONS.indexOf(m)+1})`)}"><span class="tab-bracket">[ </span>${m.label}<span class="tab-bracket"> ]</span></button>`).join('');
}
function renderControls() {
  renderTabs();
  $('#mode-controls').innerHTML = MODE_OPTIONS.map(m => `<button class="mode-option ${state.mode === m.id ? 'selected' : ''}" data-action="mode" data-mode="${m.id}" aria-pressed="${state.mode === m.id}" ${activeRun || modeBlockReason(m.id,configuredRoute?.provider) ? 'disabled' : ''} title="${e(modeBlockReason(m.id,configuredRoute?.provider))}"><span class="radio-dot"></span><span class="mode-name">${m.label}</span><span class="mode-description">${m.description}</span></button>`).join('');
  const selected=providerCatalog.flatMap(provider=>provider.routes??[]).find(route=>route.id===(state.model||configuredRoute?.model));
  const liveModelLabel = liveModel || selected?.label || configuredRouteLabel || 'Choose provider';
  const liveRoutes = providerCatalog.find(p=>p.id===configuredRoute?.provider)?.routes?.filter(route=>route.enabled!==false&&route.selectable!==false) ?? [];
  const models=liveRoutes.length?liveRoutes:[{id:'',label:configuredRouteLabel||'Choose provider and models'}];
  $('#model-controls').innerHTML = models.map(m => `<button class="model-option ${(transport === 'live' ? (state.model || configuredRoute?.model)===m.id : state.model===m.id) ? 'selected' : ''}" data-action="model" data-model="${e(m.id)}" aria-pressed="${(state.model || configuredRoute?.model)===m.id}" ${activeRun ? 'disabled' : ''}><span class="radio-dot"></span>${e(m.label)}</button>`).join('');
  $('.more-models').hidden = false;
  $('.more-models').textContent = native ? 'Manage provider and models' : 'More models…';
  $('.preview-model-dot').style.background = transport === 'live' ? 'var(--muted)' : '';
  $('#top-model').textContent = liveModelLabel;
  $('#tool-controls').innerHTML='<p class="fine-print">Babel requests approval for file changes and commands. Actual tool activity appears in each conversation.</p>';
  const percent = null;
  $('#top-context').textContent = percent == null ? '—' : `${percent}%`;
  $('#context-value').textContent = percent == null ? '—' : `${percent}%`;
  $('#context-fill').style.width = percent == null ? '0%' : `${percent}%`;
  $('#context-meter').setAttribute('aria-label', 'Context usage not reported by CLI');
  if (percent == null) $('#context-meter').removeAttribute('aria-valuenow'); else $('#context-meter').setAttribute('aria-valuenow',String(percent));
  $('#token-count').textContent=liveTokens==null?'Not reported by CLI':`${Number(liveTokens).toLocaleString('en-US')} tokens in the latest request`;
  $('#preview-badge').textContent = 'BABEL CLI';
  renderRuntime();
  renderStatus();
  refreshEmptyState();
}
function shortSha(sha) { return typeof sha === 'string' && sha ? sha.slice(0, 12) : 'unknown'; }
function runtimeUpdateText(update) {
  const u = update ?? {state:'unchecked'};
  const name = u.channel === 'release' ? 'Release' : u.channel === 'preview' ? 'Development' : u.channel === 'stable' ? 'Stable' : u.channel === 'development' ? 'Source' : 'Update';
  if (u.state === 'available') return `${name}: update available · ${shortSha(u.availableSha)}`;
  if (u.state === 'current') return `${name}: up to date (checked)`;
  if (u.state === 'checking') return `${name}: checking…`;
  if (u.state === 'error') return `${name}: check failed`;
  if (u.state === 'unsupported') return `${name}: unavailable`;
  return 'Not checked';
}
function runtimeRow(label, value, extra) {
  return `<div class="settings-row"><span>${e(label)}</span><span class="muted${extra ? ' ' + e(extra) : ''}">${e(value)}</span></div>`;
}
function renderRuntime() {
  const panel = $('#runtime-panel');
  if (!panel) return;
  const checkButton = $('#check-update');
  const updateButton = $('#update-cli');
  const setButtons = (check, update) => { checkButton.hidden = !check; updateButton.hidden = !update; };
  if (!native) { panel.innerHTML = '<p class="fine-print">Runtime identity is available in the desktop application.</p>'; setButtons(false, false); return; }
  const engine = nativeInfo?.engine;
  if (!engine) { panel.innerHTML = '<p class="fine-print">Runtime identity not reported yet.</p>'; setButtons(false, false); return; }
  if (engine.desktopVersion) $('#version').textContent = `v${engine.desktopVersion}`;
  const originLabels = {bundled:'Bundled with Desktop', official:'Development checkout', advanced:'Advanced entry', missing:'Missing'};
  const source = engine.source ?? {kind:'unknown'};
  const sourceText = engine.origin === 'bundled'
    ? `packaged · ${engine.buildVersion ?? 'version unknown'}`
    : source.kind === 'git'
      ? `${shortSha(source.commitSha)}${source.branch ? ' · ' + source.branch : ''}${source.dirty ? ' · dirty' : ''}`
      : 'unknown';
  const update = engine.update ?? {state:'unchecked'};
  panel.innerHTML = [
    runtimeRow('Desktop', engine.desktopVersion ? `v${engine.desktopVersion}` : 'unknown'),
    runtimeRow('CLI version', engine.cliPackageVersion ?? engine.buildVersion ?? 'unknown'),
    runtimeRow('CLI source', sourceText, source.dirty ? 'warn' : ''),
    runtimeRow('Engine origin', originLabels[engine.origin] ?? engine.origin ?? 'unknown'),
    runtimeRow('Execution profile', engine.executionProfile ?? 'unknown'),
    runtimeRow('Provider', engine.readiness?.provider ?? 'unknown'),
    runtimeRow('Docker', engine.readiness?.docker ?? 'unknown'),
    runtimeRow('Sandbox image', engine.readiness?.sandboxImage ?? 'unknown'),
    runtimeRow('Readiness', engine.readiness?.ready ? 'Ready' : 'Not ready'),
    runtimeRow('Update channel', update.channel === 'preview' ? 'development build' : update.channel === 'stable' ? 'stable release' : (update.channel ?? 'not set')),
    runtimeRow('Update', runtimeUpdateText(update), update.state === 'available' ? 'warn' : ''),
    runtimeRow('Effective route', configuredRouteLabel || 'Not configured'),
    nativeInfo?.remoteBridge ? runtimeRow('Remote bridge', nativeInfo.remoteBridge.running ? `Active on ${nativeInfo.remoteBridge.url ?? 'loopback'}` : `Stopped (${nativeInfo.remoteBridge.state})`) : '',
    nativeInfo?.remoteBridge?.blocksLocalRuns ? '<p class="fine-print">Local Babel runs are paused while the loopback remote bridge is active. Stop the bridge to return to local work.</p>' : '',
    nativeInfo?.remoteBridge && !nativeInfo.remoteBridge.sharedSession ? '<p class="fine-print">Remote access uses a separate CLI session; Desktop does not share one chat transcript with the phone bridge.</p>' : '',
    nativeInfo?.remoteBridge?.sharedSession ? '<p class="fine-print">Remote access shares this Desktop project session with paired phones on the same loopback protocol host.</p>' : '',
    updatePhase ? `<p class="fine-print">${e(updatePhase)}</p>` : '',
    (update.state === 'error' || update.state === 'unsupported') ? `<p class="fine-print">${e(update.detail)}</p>` : ''
  ].join('');
  checkButton.textContent = engine.origin === 'bundled' ? 'Check for CLI updates' : 'Check for CLI updates';
  const canUpdate = update.state === 'available' && (engine.origin === 'bundled' || engine.origin === 'official' || engine.origin === 'advanced');
  setButtons(true, canUpdate);
  updateButton.textContent = engine.origin === 'bundled' ? 'Update CLI' : 'Update development CLI';
}
function executionBlocked() {
  // A slow or rejected native handshake cannot admit synthetic preview tasks.
  if (!native || !nativeInfo || connecting || projectSwitching || sandboxBusy) return true;
  if(native && !nativeInfo.ready)return true;
  if(!configuredRoute)return true;
  return !isConversationOnlyConnection(nativeInfo) && nativeInfo?.packaged === true && nativeInfo.diagnostics?.ready !== true;
}
function renderStatus(status) {
  const msg = activeSession().messages.filter(m => m.role === 'assistant').at(-1);
  const s = status ?? (activeRun ? activeRun.terminalReceived ? 'finishing' : 'running' : msg?.status ?? 'ready');
  const names={running:'Running',finishing:'Finishing',failed:'Failed',blocked:'Blocked',cancelled:'Stopped',complete:'Verified',no_change:'No change',unverified:'Unverified',ready:'Ready'};
  $('#main-status').textContent = !activeRun&&executionBlocked() ? (!nativeInfo&&!connectionError&&native?'Connecting':'Setup required') : names[s] ?? 'Ready';
  $('#main-status-dot').className = `status-dot ${['failed','blocked'].includes(s) ? s : ''}`;
  $('.status-main').className = `status-main ${['failed','blocked'].includes(s) ? s : ''}`;
  const changedNote = transport === 'live' && changedFiles.length ? ` ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}.` : '';
  const liveRunning = activeRun?.stopping ? 'Stopping the Babel CLI.' : (messageHasWork(msg) ? `Babel CLI is working on this task.${changedNote}` : 'Starting the Babel CLI.');
  const detail=s==='finishing'?'Response received; waiting for the CLI to exit.':s==='running'?liveRunning:s==='unverified'?'Run ended; verification not established.':s==='failed'?'See the run details in the conversation.':s==='blocked'?'Babel is waiting for a decision.':`Connected to the Babel CLI.${changedNote}`;
  $('#status-detail').textContent = executionBlocked() ? !nativeInfo ? connectionError || (native?'Connecting to the Babel harness…':'Open the installed Babel Desktop app to run tasks.') : !nativeInfo.ready ? nativeInfo.projectRoot?'Project access requires verified trust. Open Setup.':nativeInfo.officialCliReady?'Project binding is unavailable or unknown. Open Setup. Saved sessions remain available.':'The Babel CLI is unavailable. Open Setup. Saved sessions remain available.' : !configuredRoute?'Choose a provider and default model to begin.':nativeInfo.diagnostics?.error || 'Runtime setup needs attention. Open Setup to see what is missing.' : isConversationOnlyConnection(nativeInfo)&&!activeRun?'Conversation only · select a project when you need files or commands.':detail;
  $('#send-button').disabled = Boolean(activeRun) || executionBlocked();
  $('#composer-input').disabled = projectSwitching||Boolean(activeRun&&!activeRun.admitted);
  $('.stop-button').hidden = !activeRun;
  const emergencyHostStop = Boolean(
    activeRun && nativeInfo?.remoteBridge?.sharedSession && nativeInfo?.remoteBridge?.running,
  );
  const emergencyButton = $('.emergency-stop-button');
  if (emergencyButton) emergencyButton.hidden = !emergencyHostStop;
  if (activeRun) $('.composer-hints').style.display = 'none'; else $('.composer-hints').style.removeProperty('display');
}
function renderSessions() {
  const cap = showAllSessions ? state.sessions.length : Math.max(sessionsVisibleLimit, 8);
  const visible = state.sessions.slice(0, cap);
  $('#sessions').innerHTML = visible.map(s => `<button class="session-button ${s.id === state.activeId ? 'active' : ''}" data-action="session" data-id="${e(s.id)}" aria-current="${s.id === state.activeId ? 'page' : 'false'}" title="${e(s.title)}${' · Babel session'}"><span>${e(s.title)}</span></button>`).join('');
  const moreOnDisk=savedSessionList.total > state.sessions.filter(s => s.saved).length;
  const canExpandLocal=state.sessions.length > visible.length;
  $('#show-more').hidden = !moreOnDisk && !canExpandLocal && !showAllSessions;
  $('#show-more').textContent = moreOnDisk
    ? `Load more saved chats (${savedSessionList.total} on disk)...`
    : (showAllSessions ? 'Show less...' : 'Show more...');
}
function treeMarkup(nodes, parent = '') {
  return nodes.map(n => {
    const path = parent ? `${parent}/${n.name}` : n.name;
    const isFolder = n.type === 'folder';
    const open = expandedFolders.has(path);
    return `<button class="tree-row ${isFolder ? 'tree-folder' : 'tree-file'} ${activeFile === path ? 'active-file' : ''}" data-action="${isFolder ? 'folder' : 'file'}" data-path="${e(path)}" ${isFolder ? `aria-expanded="${open}"` : ''} title="${e(path)}">${icon(isFolder ? open ? 'folderOpen' : 'folder' : n.name.endsWith('.md') ? 'readme' : 'code')}<span class="tree-label">${e(n.name)}</span></button>${isFolder && open ? `<div class="tree-children">${n.children?.length ? treeMarkup(n.children,path) : `<div class="fine-print" style="padding:4px 10px">${n.loaded ? 'Empty folder' : 'Loading...'}</div>`}</div>` : ''}`;
  }).join('');
}
function renderTree() {
  const changed = transport === 'live' && changedFiles.length ? `<div class="changed-files"><div class="section-heading"><h2>CHANGED</h2></div>${changedFiles.map(file => `<button class="tree-row tree-file" data-action="diff" data-path="${e(file.path)}" title="View diff: ${e(file.path)}">${icon('code')}<span class="tree-label">${e(file.path)}</span>${file.additions == null ? '' : `<span class="tool-meta">+${file.additions} -${file.deletions ?? 0}</span>`}</button>`).join('')}</div>` : '';
  $('#project-tree').innerHTML = `${changed}<button class="tree-row tree-root" data-action="folder" data-path="." aria-expanded="${expandedFolders.has('.')}">${icon(expandedFolders.has('.') ? 'down':'chevron')}${icon('folderOpen')}<span class="tree-label">${e(projectName)}</span></button>${expandedFolders.has('.') ? `<div class="tree-children root-children">${treeMarkup(files)}</div>` : ''}`;
}
function toolRows(rows) {
  return `<div class="tool-feed">${rows.map(t => `<div class="tool-item"><button class="tool-row ${e(t.status)}" data-action="expand-tool" data-id="${e(t.id)}" aria-expanded="${expandedTools.has(t.id)}" title="Expand ${e(t.label)}">${icon('chevron')}<span class="tool-label">${t.action ? `<span class="tool-action">${e(t.action)}</span><span class="tool-path">${e(t.path)}</span>` : `<span class="tool-path">${e(t.label)}</span>`}</span><span class="tool-meta"><span>${e(t.meta ?? (t.status === 'running' ? 'running...' : ''))}</span>${t.duration ? `<span class="duration-dot">•</span><span class="duration">${e(t.duration)}</span>` : ''}</span><span class="tool-status ${e(t.status)}">${t.status === 'complete' ? icon('check') : t.status === 'failed' ? icon('close') : ''}</span></button>${expandedTools.has(t.id) ? `<pre class="tool-detail">${e(t.detail ?? 'No additional output was reported.')}</pre>` : ''}</div>`).join('')}</div>`;
}
function messageHasWork(message) {
  if (!message) return false;
  if (message.text) return true;
  if (message.tools?.length) return true;
  return Boolean(message.blocks?.some(block => block.kind === 'note' || (block.kind === 'text' && block.text) || block.kind === 'tool'));
}
function assistantBody(m) {
  const blocks = m.blocks?.length ? m.blocks : [{kind:'text',text:m.text||''},...(m.tools??[]).map(tool=>({kind:'tool',tool}))];
  if (transport === 'live' && m.status === 'running' && !messageHasWork(m)) return '<div class="message-text starting">Starting Babel…</div>';
  const parts = [];
  let tools = [];
  const flush = () => { if (tools.length) { parts.push(toolRows(tools)); tools = []; } };
  blocks.forEach((block, index) => {
    if (block.kind === 'tool') { tools.push(block.tool); return; }
    flush();
    if (block.kind === 'note') {
      parts.push(`<details class="thought-note"><summary>${e(block.label??'Thinking')}</summary><pre class="tool-detail">${e(block.text)}</pre></details>`);
      return;
    }
    const caret = m.status === 'running' && index === blocks.length - 1 ? '<span class="stream-caret"></span>' : '';
    parts.push(`<div class="message-text">${e(block.text)}${caret}</div>`);
  });
  flush();
  return parts.join('');
}
function messageMarkup(m, index) {
  const identity=m.sourceEventId?` data-source-event-id="${e(m.sourceEventId)}"`:'';
  const archiveInfo=m.historyDetail==='legacy'?'<p class="fine-print">Older history · tool and route details unavailable.</p>':m.route&&!m.activity?`<p class="fine-print">Selected route · ${e(m.route.provider)} / ${e(m.route.model)}</p>`:'';
  const expansion=m.textTruncated||m.fullActivityAvailable?`<p class="fine-print">${m.fullActivityAvailable?'Tool previews are bounded. Complete retained arguments and output are available in sections.':'Message preview truncated. The complete retained text is available in sections.'}</p><button class="button" data-action="view-full-message" data-message-index="${e(m.archiveIndex)}" data-source-event-id="${e(m.sourceEventId??'')}" ${native?.readSessionMessage?'':'disabled'}>${m.fullActivityAvailable?'View retained tool details':'View full message'}</button>`:'';
  if (m.role === 'user') return `<article class="message user-message"${identity}><div class="message-label">YOU</div><div class="message-body message-text">${e(m.text)}${expansion}</div></article>`;
  const canApprove=m.approval&&m.approval.run_id===activeRun?.runId&&Date.parse(m.approval.expires_at)>Date.now()&&!activeRun?.stopping;
  const approval = m.pendingApproval ? `<div class="approval-card"><p>${e(m.pendingApproval)}</p>${m.approvalCommand?`<p>Operation</p><pre class="tool-detail">${e(m.approvalCommand)}</pre>${m.approvalCwd?`<p>Working directory: ${e(m.approvalCwd)}</p>`:''}${m.approvalDetails?`<details><summary>Operation payload</summary><pre class="tool-detail">${e(m.approvalDetails)}</pre></details>`:''}`:'<p class="fine-print">Operation details unavailable. Deny this request and update the runtime before retrying.</p>'}${!canApprove?'<p class="fine-print">Approval identity is missing, expired or superseded. Update an older runtime before retrying this operation.</p>':''}<div class="dialog-actions"><button class="button primary" data-action="approve-run" ${canApprove&&m.approvalCommand?'':'disabled'}>Allow</button><button class="button" data-action="deny-run" ${canApprove?'':'disabled'}>Deny</button></div></div>` : '';
  const review = m.review?.reasons?.length ? `<section class="approval-card"><strong>${e(m.review.title || 'REVIEW')}</strong><ul>${m.review.reasons.map(reason=>`<li>${e(reason)}</li>`).join('')}</ul></section>` : '';
  const evidence = m.result && ['failed','blocked','unverified'].includes(m.status) ? `<details class="raw-result"><summary>CLI result / evidence</summary><pre class="tool-detail">${e(JSON.stringify(m.result,null,2))}</pre></details>` : '';
  return `<article class="message assistant-message"${identity}><img class="assistant-avatar" src="${LOGO}" alt=""><div class="message-label">BABEL</div><div class="message-body">${assistantBody(m)}${expansion}${archiveInfo}${m.toolsTruncated?'<p class="fine-print">Tool preview limited to 100 entries. Complete retained details are available in message sections.</p>':''}${m.terminalConflict?'<p class="fine-print">Terminal records disagree. Refresh or inspect the session evidence.</p>':''}${review}${approval}${m.status && m.status !== 'running' ? `<div class="message-status ${e(m.status)}">${''}${e(({complete:'Response complete',no_change:'No change required',failed:'Run failed',blocked:'Approval or environment action required',cancelled:'Response stopped',unverified:'Run ended · not verified'})[m.status] ?? m.status)}</div>` : ''}${evidence}</div><div class="message-actions"><button data-action="copy-message" data-index="${index}" ${!m.text || m.status === 'running' ? 'disabled' : ''}>${icon('copy')} Copy</button></div></article>`;
}
let conversationFrame = null;
function scheduleConversationRender() {
  if (conversationFrame !== null) return;
  conversationFrame = requestAnimationFrame(() => {
    conversationFrame = null;
    renderConversation();
    renderStatus();
  });
}
function renderConversation(forceBottom = false, reset = false) {
  if (conversationFrame !== null) {
    cancelAnimationFrame(conversationFrame);
    conversationFrame = null;
  }
  const scroller = $('#conversation');
  const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 90;
  const previousTop = scroller.scrollTop;
  const session = activeSession();
  if (!session.fixture && session.messages.length === 0) {
    scroller.innerHTML = `<div class="empty-state"><img src="${LOGO}" alt=""><h1>Run. Verify. Understand.</h1><div class="empty-state-body">${emptyStateBody()}</div><div class="preview-note">${icon('info')}${'Babel CLI · permissions and verification built in'}</div></div>`;
  } else {
    const viewingOlder=(session.history?.olderOffset ?? 0) > 0;
    const historyWarnings=[session.history?.tailOnly?'Legacy archive reader returned a tail window only.':null,session.history?.skippedOversizedLines?'Oversized archive records could not be displayed; the original archive is preserved.':null,session.history?.snapshotChanged?'The archive changed while loading. Reload the latest messages before relying on this view.':null,session.history?.outcomesBounded?'Terminal evidence exceeds this reader’s limit; status remains unverified where evidence is unavailable.':null].filter(Boolean).map(text=>`<p class="fine-print history-banner">${e(text)}</p>`).join('');
    const historyBanner=(session.history?.hasOlder || viewingOlder ? `<div class="history-banner"><p class="muted">Showing ${session.messages.length} of ${session.history.totalMessages ?? 'unknown'} messages.</p><div class="dialog-actions">${session.history?.hasOlder ? '<button class="button" data-action="load-older-messages">Load earlier messages</button>' : ''}${viewingOlder ? '<button class="button" data-action="load-latest-messages">Return to latest messages</button>' : ''}</div></div>` : '')+historyWarnings;
    scroller.innerHTML = `${historyBanner}${session.messages.map(messageMarkup).join('')}`;
  }
  if (reset) scroller.scrollTop = 0;
  else if (forceBottom || atBottom) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = previousTop;
}
function renderAll(reset = false) {
  renderSessions(); renderTree(); renderControls(); renderConversation(false,reset); updateClock();
  if(reset)$('#conversation').scrollTo({top:activeSession()?.scrollTop??0,behavior:'instant'});
}
function newSession(initializing=false) {
  if(activeRun||(projectSwitching&&!initializing)){toast('Wait for the active run or project selection before starting a new session.');return;}
  captureComposerDraft();
  const session = {id:id(),title:'New session',messages:[]};
  state.sessions.unshift(session);
  if(state.sessions.length>60){const removable=state.sessions.findLastIndex(item=>item!==session&&!item.draft&&!item.pendingDraft);if(removable>=0)state.sessions.splice(removable,1);}
  state.activeId = session.id;$('#composer-input').value='';
  persist(); renderAll(true); resizeComposer(); $('#composer-input').focus();
  $('.workspace').classList.remove('show-left');
}
const TRACE_BEHAVIOR_PROMPT="Using this repository's README and code, trace one small documented behavior from its entry point to its implementation and nearest relevant test. Cite file paths and identify the test command documented or configured in the repository. Do not change files, install dependencies, or run tests or builds. If you cannot find a test or command, say so.";
/** Empty-state copy and starters matched to the known project scope; missing data is never treated as a trusted project. */
function emptyStateBody(){
  if(isConversationOnlyConnection(nativeInfo))return `<p>No project is open. You can ask a general question, or open a project for code questions.</p><div class="empty-actions"><button data-action="open-project">Open project</button></div>`;
  if(nativeInfo?.ready&&nativeInfo.projectRoot&&nativeInfo.projectAuthority?.trusted===true)return `<p>Send a task to Babel.<br>Responses, tool activity, and verification appear here.</p><div class="empty-actions"><button data-action="draft" data-text="${escapeHtml(TRACE_BEHAVIOR_PROMPT)}">Trace a behavior</button></div>`;
  return `<p>Open Setup to select and trust a project and choose your provider.</p><div class="empty-actions"><button data-action="connection">Open Setup</button></div>`;
}
const emptyStateMarkup=new WeakMap();
function refreshEmptyState(){
  const body=$('#conversation .empty-state-body');
  if(!body)return;
  const markup=emptyStateBody();
  if(emptyStateMarkup.get(body)!==markup){body.innerHTML=markup;emptyStateMarkup.set(body,markup);}
}
function draft(text) { if(projectSwitching)return;closeDialog(); $('#composer-input').value = text; resizeComposer();persist(); $('#composer-input').focus(); }
function resizeComposer() {
  const input = $('#composer-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(150,input.scrollHeight)}px`;
  $('.composer').classList.toggle('expanded',input.scrollHeight > 55 || input.value.length > 45);
  positionToast();
}
function openDialog(title,content,focusSelector) {
  const dialog = $('#dialog');
  if (!dialog.open) focusBeforeDialog = document.activeElement;
  $('#dialog-title').textContent = title;
  $('#dialog-content').innerHTML = content;
  if (!dialog.open) dialog.showModal();
  if (focusSelector) $(focusSelector)?.focus();
}
function closeDialog() { if ($('#dialog').open) $('#dialog').close(); }
$('#dialog').addEventListener('close',()=>{
  const dialog=$('#dialog'),active=document.activeElement;
  if(dialog.open)return;
  if(active===document.body||dialog.contains(active))focusBeforeDialog?.focus?.();
});
$('#dialog').addEventListener('click',ev=>{if(ev.target === $('#dialog')) { const r=ev.target.getBoundingClientRect(); if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom) closeDialog(); }});

function connectionDialog() {
  const d=nativeInfo?.diagnostics;
  openDialog('BABEL SETUP',`<p>Choose a provider and model to chat. Select and trust a project when you need files or commands.</p>
    ${runtimeRow('Harness',nativeInfo?.officialCliReady?'Available':'Connecting or unavailable')}
    ${runtimeRow('Project',nativeInfo?.projectName??'Not selected')}
    ${runtimeRow('Project path',nativeInfo?.projectRoot??'No project')}
    ${runtimeRow('Branch',nativeInfo?.projectAuthority?.identity?.branch??'Unknown or not a Git project')}
    ${runtimeRow('Project access',isConversationOnlyConnection(nativeInfo)?'Conversation only':nativeInfo?.projectAuthority?.trusted?'Trusted':nativeInfo?.projectAuthority?.reason??'Unknown or not trusted')}
    ${nativeInfo?.projectRoot?`<div class="dialog-actions"><button class="button" data-action="${nativeInfo.projectAuthority?.trusted?'revoke-trust':'trust-project'}">${nativeInfo.projectAuthority?.trusted?'Revoke project trust':'Trust selected project'}</button></div>`:''}
    ${runtimeRow('Provider',configuredRouteLabel||'Not selected')}
    ${runtimeRow('Docker',isConversationOnlyConnection(nativeInfo)?'Not required for conversation':d?.docker==='available'?'Running':'Start Docker Desktop for project tools')}
    ${runtimeRow('Sandbox',isConversationOnlyConnection(nativeInfo)?'Not required for conversation':d?.sandboxImage==='available'?'Verified':'Prepare an image for project tools')}
    <p class="fine-print">The recommended Linux image includes Git, Node 24 and npm. Preparing it downloads Docker image layers and may take several minutes. Other projects may need an image with their own test tools.</p>
    <div class="dialog-actions"><button class="button" data-action="prepare-sandbox" ${sandboxBusy?'disabled':''}>Prepare recommended image</button></div>
    <details><summary>Use an existing local image</summary><label class="credential-label" for="sandbox-image">Existing sandbox image</label><input class="credential-control" id="sandbox-image" spellcheck="false" value="${e(nativeInfo?.sandbox?.reference??'')}" ${sandboxBusy?'disabled':''}><div class="dialog-actions"><button class="button" data-action="save-sandbox" ${sandboxBusy?'disabled':''}>Validate and use image</button></div><p class="fine-print">Validation runs an isolated shell and Git check without mounting your project. The verified image is saved for Desktop and Babel Harness.cmd.</p></details>
    <p id="sandbox-status" class="fine-print" role="status">${e(sandboxStatus)}</p>
    ${d?.error||connectionError?`<p class="provider-error">${e(d?.error||connectionError)}</p>`:''}
    <div class="dialog-actions"><button class="button" data-action="open-project">Open project</button><button class="button" data-action="configure-provider">Choose provider and models</button><button class="button" data-action="refresh-diagnostics">Recheck setup</button><button class="button primary" data-action="use-live">Done</button></div>
    <details><summary>Runtime details</summary><p>File changes and commands follow Babel’s approval rules. Stop cancels the active run. Credential presence does not establish authentication.</p><pre>${e(nativeInfo?.configDirectory??'')}</pre></details>`);
  if(sandboxBusy)$('#dialog-content').querySelectorAll('button').forEach(button=>button.disabled=true);
}
async function configureSandboxFromDialog(prepareRecommended){
  if(!native||sandboxBusy||activeRun||connecting)return;
  const options=prepareRecommended?{prepareRecommended:true}:{reference:$('#sandbox-image')?.value.trim(),prepareRecommended:false};
  sandboxBusy=true;sandboxStatus=prepareRecommended?'Downloading and verifying the recommended image…':'Verifying the local image…';
  renderControls();connectionDialog();
  try{
    nativeInfo=await native.configureSandbox(options);
    connectionError='';sandboxStatus='Sandbox verified and saved. Desktop and the installed CLI use the same image.';
  }catch(error){sandboxStatus=String(error?.message??'Sandbox setup failed. Start Docker Desktop and try again.');}
  finally{sandboxBusy=false;renderControls();connectionDialog();}
}
async function providerCredentialsDialog() {
  if(!native){toast('Open Babel Desktop to configure a provider.');return;}
  let providers,currentRoute;
  try {providers=await native.listQualifiedProviders();currentRoute=await native.readProviderRoute();}
  catch(error){toast(error.message||'Provider catalog is unavailable.');return;}
  const selectedProvider=currentRoute?.provider??providers[0]?.id;
  const options=providers.map(spec=>`<option value="${e(spec.id)}">${e(spec.label)}</option>`).join('');
  openDialog('PROVIDERS AND MODELS',`<p>Choose a provider, enable the models you want to use, and set a default.</p>
    <label class="credential-label" for="credential-provider">Provider</label><select class="credential-control" id="credential-provider">${options}</select>
    <label class="credential-label" for="credential-key">API key</label><input class="credential-control" id="credential-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="Leave blank to keep your saved key">
    <p class="fine-print" id="provider-key-hint">Private credentials use OS protection when available. Saved keys are never returned to this dialog.</p>
    <div class="dialog-actions"><button class="button" data-action="refresh-models" id="refresh-models">Refresh available models</button></div>
    <p id="provider-catalog-status" class="fine-print"></p><label class="credential-label" for="credential-model">Default model</label><select class="credential-control" id="credential-model"></select>
    <label class="credential-label" for="model-search">Enabled models</label><input class="credential-control" id="model-search" type="search" placeholder="Search models">
    <div id="enabled-models" class="enabled-model-list"></div>
    <p id="provider-error" class="provider-error" role="alert"></p>
    <label class="credential-label" for="credential-operation">Key action</label><select class="credential-control" id="credential-operation"><option value="add">Add a new key</option><option value="replace">Replace the saved key</option></select><p id="credential-status" class="fine-print" role="status"></p><div class="dialog-actions"><button class="button" id="remove-provider-key" disabled>Remove saved key</button><button class="button" id="migrate-provider-key" hidden>Migrate legacy key</button></div><label id="credential-migration-consent" hidden><input type="checkbox" id="credential-retain-recovery"> Keep the original plaintext private .env for recovery. Migration does not erase it.</label><details><summary>Credential storage</summary><label class="credential-label" for="credential-scope">Save to</label><select class="credential-control" id="credential-scope"><option value="private">Private profile (OS-protected)</option>${nativeInfo?.projectName?'<option value="project">Selected project (Git-ignored .env only)</option>':''}</select><p class="fine-print">Leave the key blank to retain it. Project storage is plaintext and requires an ignored, untracked file. In the CLI, pass --project-root with this project’s path.</p></details>
    <div class="dialog-actions provider-save-actions"><button class="button primary" data-action="save-provider-credential">Save provider</button><button class="button" data-action="close-dialog">Cancel</button></div>`,'#credential-provider');
  const providerSelect=$('#credential-provider'),modelSelect=$('#credential-model');
  $('#credential-scope').value=nativeInfo?.projectCredentialsSelected&&nativeInfo?.projectName?'project':'private';
  providerSelect.value=selectedProvider;
  const renderModels=()=>{
    const spec=providers.find(spec=>spec.id===providerSelect.value);
    const routes=spec?.routes??[];
    const defaultId=currentRoute?.provider===spec?.id?currentRoute.model:spec?.defaultModel??routes.find(route=>route.enabled!==false)?.id??routes[0]?.id;
    modelSelect.innerHTML=routes.map(route=>`<option value="${e(route.id)}" ${route.selectable===false?'disabled':''}>${e(route.label)}${route.selectable===false?' · unavailable':''}</option>`).join('');
    if(defaultId)modelSelect.value=defaultId;
    $('#enabled-models').innerHTML=routes.map(route=>`<label class="enabled-model" data-model-label="${e((route.label+' '+route.id).toLowerCase())}"><input type="checkbox" value="${e(route.id)}" ${route.enabled!==false||route.id===defaultId?'checked':''} ${route.selectable===false?'disabled':''}><span>${e(route.label)}<small>${e(route.modelId??route.id)}</small><small>${e(route.unavailableReason || (route.qualification==='unverified' ? 'Not live-tested · tools '+(route.capabilities?.tools===true?'listed':route.capabilities?.tools===false?'not listed':'unknown') : ''))}</small></span></label>`).join('')||'<p class="fine-print">Refresh available models to load this provider’s catalog.</p>';
    $('#credential-key').disabled=spec?.requiresApiKey===false;
    $('#credential-scope').disabled=spec?.requiresApiKey===false;
    $('#provider-key-hint').textContent=spec?.local?'Lists models registered with the local Ollama daemon. Execution may be local or cloud-backed; locality needs separate verification.':'Leave the key blank to retain it. Choose Add or Replace for the selected destination.';
    $('#provider-error').textContent='';
    $('#refresh-models').disabled=!native.refreshModels;
    const catalog=spec?.catalog;
    $('#provider-catalog-status').textContent=catalog?.fetchedAt?`${catalog.status==='cached'?'Cached catalog':'Catalog refreshed'}: ${catalog.fetchedAt}. Discovery does not establish account access or live qualification.`:'Bundled choices; refresh official metadata for current availability.';
  };
  const scopeSelect=$('#credential-scope');
  let statusRevision=0;
  const refreshCredentialStatus=async()=>{
    const revision=++statusRevision;
    delete scopeSelect.dataset.binding;
    $('#remove-provider-key').disabled=true;$('#migrate-provider-key').hidden=true;$('#credential-migration-consent').hidden=true;
    if(!native.providerCredentialStatus){$('#credential-status').textContent='Credential status is unavailable in this preview.';return;}
    $('#credential-status').textContent='Checking selected credential destination…';
    try{
      const status=await native.providerCredentialStatus({provider:providerSelect.value,scope:scopeSelect.value});
      if(revision!==statusRevision||!scopeSelect.isConnected)return;
      scopeSelect.dataset.binding=status.binding;
      $('#credential-operation').value=status.configured?'replace':'add';
      $('#credential-status').textContent=status.storage==='legacy-plaintext'?'Legacy plaintext key found. Migrate it before replacing or removing. The original file is retained for recovery.':status.storage==='project-plaintext'?`Project plaintext storage. ${status.configured?'A saved key is present.':'No key saved.'}`:status.storage==='os-protected'?`OS-protected storage. ${status.configured?'A saved key is present.':'Key removed.'}`:status.protectionAvailable?'OS protection is available. No key saved.':'OS protection is unavailable. Private key writes are disabled.';
      $('#remove-provider-key').disabled=!status.configured||status.migrationAvailable;
      $('#migrate-provider-key').hidden=!status.migrationAvailable;
      $('#migrate-provider-key').disabled=!status.protectionAvailable;
      $('#credential-migration-consent').hidden=!status.migrationAvailable;
    }catch(error){if(revision===statusRevision&&scopeSelect.isConnected)$('#credential-status').textContent=error.message||'Credential status unavailable.';}
  };
  providerSelect.addEventListener('change',()=>{$('#credential-key').value='';currentRoute=null;renderModels();refreshCredentialStatus();});
  scopeSelect.addEventListener('change',()=>{$('#credential-key').value='';$('#credential-retain-recovery').checked=false;refreshCredentialStatus();});
  for(const [id,method] of [['remove-provider-key','removeProviderCredential'],['migrate-provider-key','migrateProviderCredential']]){
    $('#'+id).addEventListener('click',async ev=>{
      const button=ev.currentTarget;$('#credential-key').value='';button.disabled=true;
      try{
        await native[method]({provider:providerSelect.value,scope:scopeSelect.value,binding:scopeSelect.dataset.binding,confirm:$('#credential-retain-recovery').checked});
        toast(method==='removeProviderCredential'?'Saved key removed from the selected destination.':'Key migrated. Original plaintext recovery file retained.');
      }catch(error){$('#provider-error').textContent=error.message||'Credential change failed.';}
      finally{if(button.isConnected)await refreshCredentialStatus();}
    });
  }
  modelSelect.addEventListener('change',()=>{const box=[...$('#enabled-models').querySelectorAll('input')].find(box=>box.value===modelSelect.value);if(box)box.checked=true;});
  $('#model-search').addEventListener('input',ev=>{const query=ev.target.value.toLowerCase();for(const row of $('#enabled-models').querySelectorAll('label'))row.hidden=!row.dataset.modelLabel.includes(query);});
  $('#refresh-models').addEventListener('click',async ev=>{
    const button=ev.currentTarget;button.disabled=true;button.textContent='Loading models…';
    try {await native.refreshModels(providerSelect.value);providers=await native.listQualifiedProviders();renderModels();}
    catch(error){$('#provider-error').textContent=error.message||'Could not refresh models. Retry when connected.';}
    finally{button.textContent='Refresh available models';button.disabled=false;}
  });
  renderModels();refreshCredentialStatus();
}
async function saveProviderFromDialog(button) {
  const keyInput=$('#credential-key');
  const provider=$('#credential-provider')?.value;
  const model=$('#credential-model')?.value;
  const scope=$('#credential-scope')?.value ?? 'private';
  const apiKey=keyInput?.value??'';
  keyInput.value=''; // Clear the DOM before crossing the narrow native bridge.
  button.disabled=true;
  try {
    const result=await native.saveProviderRoute({provider,apiKey,scope,model,binding:$('#credential-scope')?.dataset.binding,credentialOperation:$('#credential-operation')?.value??'add',enabledModels:[...document.querySelectorAll('#enabled-models input:checked:not(:disabled)')].map(input=>input.value)});
    const route=result?.route ?? {provider, model};
    configuredRoute=route;state.model=route.model;
    if(modeBlockReason(state.mode,route.provider)) {state.mode='chat';announce('Chat selected. Plan and Deep need an authorized project and a supported provider.');}
    configuredRouteLabel=`${route.provider} · ${route.model}`;
    try { providerCatalog=await native.listQualifiedProviders(); } catch {}
    nativeInfo=await native.refreshDiagnostics();
    closeDialog();
    toast(result.credentialUpdated ? 'Credential and route saved.' : 'Provider route saved.');
    renderControls();
  } catch(error) {
    const target=$('#provider-error');if(target)target.textContent=String(error?.message??'Could not save provider.');else toast('Provider setup failed.');
  } finally {
    button.disabled=false;
  }
}

function settingsDialog() {
  openDialog('SETTINGS',`<div class="settings-row"><span>Provider and models</span><button class="button" data-action="configure-provider">Manage</button></div>
    <div class="settings-row"><span>Runtime setup</span><button class="button" data-action="connection">Open setup</button></div>
    <div class="settings-row"><label><input id="reduce-motion" type="checkbox" ${document.body.classList.contains('reduce-motion')?'checked':''}> Reduce motion</label></div>
    <h3>KEYBOARD</h3><div class="settings-row"><span>Send message</span><code>Enter · Shift + Enter for newline</code></div><div class="settings-row"><span>Search sessions and files</span><code>Ctrl + K</code></div><div class="settings-row"><span>New session</span><code>Ctrl + Alt + N</code></div><div class="settings-row"><span>Switch Chat / Plan / Deep</span><code>Alt + 1 / 2 / 3</code></div>
    ${nativeInfo?.remoteBridge?`<details><summary>Remote access</summary><p>Loopback access uses a separate CLI session.</p><div class="dialog-actions"><button class="button" data-action="${nativeInfo.remoteBridge.running?'stop':'start'}-remote-bridge">${nativeInfo.remoteBridge.running?'Stop':'Start'} remote bridge</button></div></details>`:''}`);
  $('#reduce-motion').addEventListener('change',ev=>{document.body.classList.toggle('reduce-motion',ev.target.checked);try{localStorage.setItem('babel-motion',ev.target.checked?'reduce':'normal');}catch{}});
}
function modelsDialog(){providerCredentialsDialog();}
function flattenFiles(nodes,parent='') {
  return nodes.flatMap(node=>{
    const path=parent?`${parent}/${node.name}`:node.name;
    return node.type==='folder'?flattenFiles(node.children??[],path):[{name:node.name,path}];
  });
}
function searchDialog() {
  openDialog('SEARCH',`<form id="history-search-form"><input class="search-input" id="search-input" type="search" maxlength="500" placeholder="Search conversations and files..." aria-label="Search conversations and files" autocomplete="off"><button class="button" id="search-archive-button" ${native?.searchSessions?'':'disabled'}>Search archive</button></form><p class="fine-print" id="search-status" role="status">Type to filter visible titles and loaded file names. Search archive finds retained conversation text.</p><div id="search-results" class="search-results"></div>`,'#search-input');
  const input=$('#search-input'),results=$('#search-results'),status=$('#search-status'),searchButton=$('#search-archive-button');
  let generation=0,busy=false;
  const update = ()=>{
    generation++;
    const q=input.value.toLowerCase().trim();
    const sessions=state.sessions.filter(s=>s.title.toLowerCase().includes(q)).slice(0,8);
    const matches=flattenFiles(files).filter(f=>f.path.toLowerCase().includes(q)).slice(0,12);
    results.innerHTML = sessions.map(s=>`<button class="search-result" data-action="search-session" data-id="${e(s.id)}">${icon('terminal')}<span>${e(s.title)}</span><small>Session</small></button>`).join('')+matches.map(f=>`<button class="search-result" data-action="search-file" data-path="${e(f.path)}">${icon('file')}<span>${e(f.path)}</span><small>File</small></button>`).join('') || '<p class="muted">No visible title or file matches. Search the archive for conversation text.</p>';
  }; update(); input.addEventListener('input',update);
  $('#history-search-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const query=input.value.trim();
    if(busy||!query||!native?.searchSessions)return;
    const request=++generation;busy=true;searchButton.disabled=true;status.textContent='Searching retained conversations…';
    try{
      const found=await native.searchSessions(query);
      if(!results.isConnected||request!==generation)return;
      results.innerHTML=(found.results??[]).map(hit=>`<button class="search-result" data-action="search-archive-hit" data-session="${e(hit.sessionId)}" data-title="${e(hit.title)}" data-offset="${e(hit.olderOffset)}" data-message-index="${e(hit.messageIndex)}" data-source-event-id="${e(hit.sourceEventId??'')}" data-match-offset="${e(hit.matchOffset??0)}"><span>${e(hit.title)}<br><small>${e(hit.excerpt)}</small></span><small>${hit.snapshotChanged?'Changed during search':'Conversation'}</small></button>`).join('')||'<p class="muted">No retained conversation text matches.</p>';
      status.textContent=`${found.totalMatches??0} matching messages.${found.hasMore?' Showing the first results; refine your search to find more.':''}${found.unavailableSessions||found.skippedOversizedLines?' Some archive records could not be searched.':''}${found.changedSessions?' Some conversations changed during search; repeat to refresh.':''}`;
    }catch(error){if(status.isConnected&&request===generation)status.textContent=error.message||'Archive search failed. Retry.';}
    finally{busy=false;if(searchButton.isConnected)searchButton.disabled=false;if(status.isConnected&&request!==generation)status.textContent='Query changed. Search archive again for the current text.';}
  });
}
async function showSavedMessage(sessionId,messageIndex,charOffset=0,sourceEventId) {
  if(!native?.readSessionMessage)return;
  openDialog('ARCHIVED MESSAGE','<p id="archive-message-loading" role="status">Loading message section…</p>');
  const pending=$('#archive-message-loading');
  try{
    const page=await native.readSessionMessage({sessionId,messageIndex,charOffset,...(sourceEventId?{sourceEventId}:{})});
    if(!pending.isConnected||!$('#dialog').open)return;
    const pageButton=(label,offset)=>`<button class="button" data-action="message-section" data-session="${e(sessionId)}" data-message-index="${e(page.messageIndex??messageIndex)}" data-source-event-id="${e(page.sourceEventId??sourceEventId??'')}" data-offset="${offset}">${label}</button>`;
    openDialog('ARCHIVED MESSAGE',`<p class="fine-print">Characters ${page.charOffset+1}–${page.charOffset+page.text.length} of ${page.totalCharacters}. Read-only retained text.</p><pre class="tool-detail">${e(page.text)}</pre><div class="dialog-actions">${page.hasPrevious?pageButton('Previous section',Math.max(0,page.charOffset-250000)):''}${page.hasNext?pageButton('Next section',page.charOffset+page.text.length):''}</div>`);
  }catch(error){if(pending.isConnected&&$('#dialog').open)pending.textContent=error.message||'Could not load archived message.';}
}
async function openFile(path) {
  activeFile=path;renderTree();
  if (nativeInfo?.projectName && transport === 'live') {
    try { const r = await native.readFile(path); openDialog(path,`<div class="file-info"><span>READ-ONLY</span><span>${r.truncated ? 'Truncated to 256 KB' : 'Project file'}</span></div><pre>${e(r.text)}</pre>`); }
    catch(err){openDialog('FILE UNAVAILABLE',`<p>${e(err.message)}</p>`);}
  } else {
    toast('Open a project in Babel Desktop to inspect files.');
  }
}
async function openDiff(path){
  if(!native?.readDiff){toast('This runtime does not support the diff viewer. Update Babel Desktop.');return;}
  openDialog(`DIFF · ${path}`,'<p id="diff-loading" role="status">Loading project diff…</p>');
  const pending=$('#diff-loading');
  try{
    const result=await native.readDiff(path);
    if(!pending.isConnected||!$('#dialog').open)return;
    const baseline=result.baseRevision?`HEAD ${result.baseRevision}`:'No HEAD baseline · preview against empty content';
    openDialog(`DIFF · ${path}`,`<p class="fine-print">${e(baseline)} → current working tree. Includes staged and unstaged changes. This view does not establish verification.</p>${result.truncated?'<p role="status">Diff preview is truncated. Review the complete patch in Git before relying on this view.</p>':''}<pre class="tool-detail">${e(result.diff|| (result.truncated?'Incomplete diff output.':'No difference from the displayed baseline.'))}</pre><div class="dialog-actions"><button class="button" data-action="file" data-path="${e(path)}">View current file</button></div>`);
  }catch(error){if(pending.isConnected&&$('#dialog').open)pending.textContent=error.message||'Project diff is unavailable.';}
}
async function toggleFolder(path) {
  if (expandedFolders.has(path)) expandedFolders.delete(path);
  else {
    expandedFolders.add(path);
    if (transport === 'live' && path!=='.') {
      let current=files; let target;
      for(const name of path.split('/')){target=current.find(n=>n.name===name);current=target?.children??[];}
      if(target&&!target.loaded){try{target.children=await native.listDirectory(path);target.loaded=true;}catch(err){toast(err.message);expandedFolders.delete(path);}}
    }
  }
  renderTree();
}
function settleTools(message, status) {
  for (const tool of message.tools ?? []) {
    if (tool.status !== 'running') continue;
    tool.status = status;
    tool.meta = '';
  }
}
async function emergencyHostStopRun() {
  if (!native?.emergencyStopSharedRun || !activeRun) return;
  const result = await native.emergencyStopSharedRun();
  if (!result?.accepted) {
    toast(
      result?.reason === 'missing_host_token'
        ? 'Emergency host stop is unavailable (missing bridge admin token).'
        : 'Emergency host stop was not accepted.',
    );
    return;
  }
  activeRun.emergencyRequested = true;
  announce('Emergency host stop requested (local admin).');
  renderControls();
}

function stopRun() {
  if (!activeRun) return;
  if (transport === 'live') {
    native?.cancel?.();
    activeRun.stopping = true;
    activeRun.message.stopping = true;
    activeRun.message.pendingApproval = '';
    activeRun.message.approval = null;
    renderConversation();
    renderControls();
    announce('Babel run stopping.');
    return;
  }
  clearInterval(activeRun.timer);
  activeRun.message.status='cancelled';activeRun=null;
  persist();renderConversation();renderControls();announce('Babel run stopped.');$('#composer-input').focus();
}
function appendNote(message, extra) {
  const line = String(extra ?? '').slice(0, 4000);
  if (!line) return;
  message.blocks ??= [];
  const note = [...message.blocks].reverse().find(block => block.kind === 'note');
  if (note) note.text = `${note.text}\n${line}`.slice(0, 8000);
  else message.blocks.push({kind:'note', text:line});
}
function appendLiveText(message, extra) {
  message.text = (message.text + extra).slice(0, 250000);
  message.blocks ??= [];
  const last = message.blocks.at(-1);
  if (last?.kind === 'text') last.text = (last.text + extra).slice(0, 250000);
  else message.blocks.push({kind:'text', text:extra});
}
function upsertLiveTool(message, tool) {
  message.tools ??= [];
  message.blocks ??= [];
  const existing = message.tools.find(item => item.id === tool.id);
  if (existing) {
    // A delayed/duplicate start cannot erase the operation's completion evidence.
    if (tool.status === 'running' && existing.status !== 'running') return;
    Object.assign(existing, tool);
    const block = message.blocks.find(item => item.kind === 'tool' && item.tool.id === tool.id);
    if (block) block.tool = existing;
    return;
  }
  if (message.tools.length >= 100) return;
  message.tools.push(tool);
  message.blocks.push({kind:'tool', tool});
}
async function sendMessage() {
  const unavailableMode=modeBlockReason(state.mode,configuredRoute?.provider);
  if(unavailableMode){toast(unavailableMode);return;}
  const input=$('#composer-input');const text=input.value.trim();
  if(!text||activeRun)return;
  if(executionBlocked()){connectionDialog();return;}
  if(text.length>24000){toast('Please keep a single message under 24,000 characters.');return;}
  const session=activeSession();
  if(session.loadingLatestForSend)return;
  if((session.history?.olderOffset??0)>0){
    const selection={mode:state.mode,model:state.model,provider:configuredRoute?.provider};
    session.loadingLatestForSend=true;
    try{if(await openSavedSession(session,{olderOffset:0,forceReload:true})===false)return;}
    catch(error){toast(error.message||'Could not load the latest history. Your draft is retained.');return;}
    finally{session.loadingLatestForSend=false;}
    if(activeSession()!==session||activeRun)return;
    renderConversation();
    if(input.value.trim()!==text||selection.mode!==state.mode||selection.model!==state.model||selection.provider!==configuredRoute?.provider){toast('The draft or route changed while history loaded. Send again when ready.');return;}
    if(executionBlocked()||modeBlockReason(state.mode,configuredRoute?.provider)){renderControls();connectionDialog();return;}
  }
  session.messages.push({role:'user',text});
  if(session.title==='New session'||session.title==='New read-only run') session.title=text.length>27?text.slice(0,27)+'...':text;
  const message={role:'assistant',text:'',status:'running',tools:[],blocks:[]};session.messages.push(message);
  // The CLI archive owns older turns; a bounded display page is not a turn limit.
  if(session.babelSessionId && session.messages.length>150){
    const removed=session.messages.length-150;
    session.messages.splice(0,removed);
    session.history={...session.history,hasOlder:true,olderOffset:0,messageLimit:150,
      totalMessages:(session.history?.totalMessages??150)+2};
  }
  session.pendingDraft=text;input.value='';resizeComposer();
  session.historyLoadGeneration=(session.historyLoadGeneration??0)+1;
  const runId=id();activeRun={runId,sessionId:session.id,mode:state.mode,message,timer:null};
  renderSessions();renderConversation(true);renderControls();announce('Babel run requested.');
  if(transport==='live') {
    try {
      const result=await native.run({runId,task:text,mode:state.mode,...((state.model||configuredRoute?.model)?{model:state.model||configuredRoute.model}:{}),...(state.mode==='chat'&&session.babelSessionId?{sessionId:session.babelSessionId}:{})});
      if(result.started&&activeRun?.runId===runId)activeRun.admitted=true;
      if(!result.started && activeRun?.runId===runId){message.status='cancelled';message.text='Run was not started. No model call was made.';if(!input.value)input.value=text;resizeComposer();activeRun=null;renderConversation();renderControls();}
    } catch(err){if(activeRun?.runId===runId){message.status='failed';message.text=err.message;if(!input.value)input.value=text;resizeComposer();activeRun=null;renderConversation();renderControls();}}
    finally{delete session.pendingDraft;persist();renderControls();}
    return;
  }
}

function handleNativeEvent(packet) {
  if(!activeRun||packet.runId!==activeRun.runId)return;
  const run=activeRun;const message=run.message;
  if(packet.kind==='exit') {
    const poisoned = Boolean(run.transportError || packet.displayLimited);
    if(packet.code!==0){
      if(message.status==='running' && !message.text) appendLiveText(message,'\n\nThe CLI exited before Babel reported a result.');
      message.status='failed';
      settleTools(message,'failed');
    } else if(poisoned && (message.status==='running' || message.status==='complete')){
      message.status='unverified';
      settleTools(message,'unverified');
      appendLiveText(message,'\n\nThe event stream was incomplete. Inspect Babel’s run evidence before trusting completion.');
    } else if(message.status==='running' && run.stopping){
      message.status='cancelled';
      settleTools(message,'cancelled');
    } else if(message.status==='running'){
      message.status='unverified';
      settleTools(message,'unverified');
      if(!message.text)appendLiveText(message,'The CLI exited without a terminal result.');
    }
    settleTools(message,'unverified');
    message.stopping=false;
    activeRun=null;
  } else if(packet.kind==='transport-error') {
    run.transportError=true;appendLiveText(message,`\n\nTransport: ${String(packet.error).slice(0,4000)}`);
  } else if(packet.kind==='event') {
    const ev=normalizeEvent(packet.event);
    if (packet.event?.type === 'file.changed') {
      const item = packet.event.item ?? {};
      changedFiles = rememberChange(changedFiles, item.path, Number(item.additions), Number(item.deletions));
      renderTree();
      const row = absorbFileChange(message.tools, item);
      if (row && !message.tools?.includes(row)) upsertLiveTool(message, row);
    }
    if(ev.kind==='delta'){
      appendLiveText(message,ev.text);
      // Keep every chunk in state; paint bursts once per frame. Other events
      // render immediately, including approvals, terminal evidence and exit.
      if(state.activeId===run.sessionId)scheduleConversationRender();
      return;
    }
    else if(ev.kind==='thought' || ev.kind==='progress') appendNote(message, ev.text);
    else if(ev.kind==='start' && ev.model && ev.model !== 'default' && ev.model !== 'unknown'){liveModel=ev.model;}
    else if(ev.kind==='approval'){
      if(run.terminalReceived||run.stopping)return;
      message.pendingApproval=ev.text;message.approval=ev.approval?.run_id===run.runId?ev.approval:null;
      message.approvalCommand=ev.command;message.approvalCwd=ev.cwd;message.approvalDetails=ev.details;
      if(ev.reconciled)appendNote(message,'Approval state was reconciled from the shared protocol host.');
    }
    else if(ev.kind==='control'){
      if(run.terminalReceived)return;
      appendNote(message, ev.text);
      message.status='running';
      if(ev.operation==='cancel'){
        run.stopping=false;
        message.stopping=false;
        message.pendingApproval='';
        message.approval=null;
        message.approvalCommand='';
        message.approvalCwd='';
        message.approvalDetails='';
        renderConversation();
        renderControls();
      }
    }
    else if(ev.kind==='transport'){
      if(run.terminalReceived)return;
      appendNote(message, ev.text);
      if(!ev.recoverable)run.transportError=true;
    }
    else if(ev.kind==='terminal') {
      // Replayed success cannot erase a terminal failure, block or cancellation.
      if(run.terminalReceived && ['failed','blocked','cancelled'].includes(message.status) && ev.status!=='failed')return;
      run.terminalReceived = true;
      message.pendingApproval='';
      message.approval=null;
      const status = verifiedStatus(ev.status, run.transportError);
      message.status=status;
      // Terminal task evidence is not evidence that each outstanding tool succeeded.
      settleTools(message, status==='cancelled'?'cancelled':'unverified');
      if(!message.text&&ev.text)appendLiveText(message,ev.text.slice(0,250000));
      if(!message.text)appendLiveText(message,'Babel returned a structured result.');
      message.result=ev.raw;
      message.review=reviewFromResult(ev.raw);
      for (const row of toolsFromResult(ev.raw, message.tools)) upsertLiveTool(message, row);
      const resumed=sessionIdFromResult(ev.raw);
      if(resumed&&run.mode==='chat'){const owner=state.sessions.find(item=>item.id===run.sessionId);if(owner){owner.babelSessionId=resumed;persist();}}
      const reportedModel = liveModelFromResult(ev.raw);
      if (reportedModel) liveModel = reportedModel;
      const requestTokens = liveRequestTokens(ev.raw);
      if (requestTokens != null) liveTokens = requestTokens;
      if (Array.isArray(ev.raw?.changed_files)) {
        for (const path of ev.raw.changed_files) changedFiles = rememberChange(changedFiles, path, null, null);
        renderTree();
      }
      // Keep activeRun until the process exits; prevents overlapping children.
    } else if(ev.kind==='tool' && packet.event?.type !== 'file.changed') upsertLiveTool(message,ev);
  }
  if(state.activeId===run.sessionId)renderConversation();
  renderControls();
}
async function checkForUpdates() {
  if (!native) { toast('Update checks require the desktop application.'); return; }
  const button = $('#check-update'); const label = button.textContent;
  button.disabled = true; button.textContent = 'Checking…';
  try { await native.checkCliUpdate(); nativeInfo = await native.getInfo(); }
  catch (err) { toast(`Update check failed: ${err.message}`); }
  finally { button.disabled = false; button.textContent = label; }
  renderRuntime();
}
async function runUpdateCli() {
  if (!native) return;
  const button = $('#update-cli'); button.disabled = true; updatePhase = 'Starting…'; renderRuntime();
  try {
    const packaged = nativeInfo?.packaged === true;
    const result = packaged ? await native.updatePackagedCli?.() : await native.updateDevCli();
    if (result?.upToDate) toast('The CLI already matches the tracked upstream.');
    else if (result?.started === false) toast('Update cancelled.');
    else if (result?.ok) toast(`CLI updated to ${shortSha(result.sourceSha)} (${result.version}).`);
    else toast(`Update stopped at ${result?.phase ?? 'update'}: ${result?.reason ?? 'unknown'}.`);
    nativeInfo = await native.getInfo();
  } catch (err) { toast(`Update failed: ${err.message}`); }
  finally { button.disabled = false; updatePhase = ''; renderRuntime(); }
}
async function chooseProject() {
  if(!native){connectionDialog();return;}
  if(connecting||projectSwitching){toast('Wait for the project to finish loading before switching projects.');return;}
  if(activeRun){toast('Wait for the active run before switching projects.');return;}
  projectSwitching=true;renderControls();
  try{
    persist();if(!await flushComposerDrafts())return;
    const info=await native.chooseProject();if(!info)return;
    const changed=info.projectRoot!==nativeInfo?.projectRoot || info.projectName!==nativeInfo?.projectName;
    nativeInfo=info;
    if(changed)await enableLive();
    renderControls();connectionDialog();
  }catch(err){toast(err.message);}
  finally{projectSwitching=false;renderControls();}
}
async function enableLive() {
  if(!native||!nativeInfo||activeRun||connecting){closeDialog();return;}
  const projectRoot=nativeInfo.projectRoot??nativeInfo.projectName??null;
  if(connectionInitialized&&projectRoot===connectedProjectRoot){closeDialog();renderControls();return;}
  connecting=true;
  try{
  const initialDraft=connectionInitialized?'':$('#composer-input').value;
  composerDraftState=null;composerDraftPending=null;composerDraftFailure=false;
  state={version:1,mode:'chat',model:'',sessions:[],activeId:''};
  liveModel='';liveTokens=null;changedFiles=[];
  files=[];projectName=nativeInfo.projectName || 'No project';expandedFolders=new Set(['.']);
  closeDialog();newSession(true);
  if(initialDraft){$('#composer-input').value=initialDraft;activeSession().draft=initialDraft;resizeComposer();}
  try{
    if(native.readComposerDrafts){
      composerDraftState=await native.readComposerDrafts();
      if(composerDraftState.readOnly){composerDraftFailure=true;toast('Saved drafts use an unsupported format. They remain on disk; copy new text before closing.');}
      else for(const entry of composerDraftState.drafts??[]){
        state.sessions.push({id:entry.id,title:entry.title,messages:[],draft:entry.text,scrollTop:entry.scrollTop,historyOffset:entry.historyOffset??0,...(entry.sessionId?{babelSessionId:entry.sessionId,saved:true}:{})});
      }
    }
  }catch{composerDraftFailure=true;toast('Saved drafts could not be loaded. Existing data was preserved.');}
  files=nativeInfo.projectName&&nativeInfo.projectAuthority?.trusted!==false ? await native.listDirectory('.') : [];
  renderTree();
  try {
    const saved = await native.listSessions({limit: savedSessionList.limit, offset: 0});
    savedSessionList={offset: saved.offset ?? 0, total: saved.total ?? saved.sessions?.length ?? 0, limit: saved.limit ?? 30};
    for (const item of (saved.sessions ?? saved)) {
      if (state.sessions.some(session => session.babelSessionId === item.id)) continue;
      state.sessions.push({ id: id(), title: item.title || 'Saved chat', messages: [], babelSessionId: item.id, saved: true, messageCount: item.messages });
    }
  } catch { /* A missing runs directory leaves the new session in place. */ }
  configuredRoute=null;configuredRouteLabel='';providerCatalog=[];
  try {
    const route=await native.readProviderRoute();
    if(route){configuredRoute=route;state.model=route.model;configuredRouteLabel=`${route.provider} · ${route.model}`;}
    if(native.listQualifiedProviders)providerCatalog=await native.listQualifiedProviders();
  } catch {toast('Provider settings could not be loaded. Open Providers and models to retry.');}
  renderSessions();renderControls();persist();
  connectedProjectRoot=projectRoot;connectionInitialized=true;
  announce('Babel CLI connected.');
  }finally{connecting=false;renderControls();}
}
function mapLoadedMessages(messages) {
  return (messages ?? []).map(hydrateArchivedMessage);
}
async function openSavedSession(session, {olderOffset = 0, forceReload = false} = {}) {
  if (!session?.babelSessionId) return;
  if(activeRun?.sessionId===session.id)return false;
  const atLatestWindow = olderOffset === 0 && (session.history?.olderOffset ?? 0) === 0;
  if (!forceReload && atLatestWindow && session.messages.length) return;
  const generation=session.historyLoadGeneration=(session.historyLoadGeneration??0)+1;
  const loaded = await native.openSession(session.babelSessionId, {olderOffset});
  if(session.historyLoadGeneration!==generation||activeRun?.sessionId===session.id)return false;
  session.messages = mapLoadedMessages(loaded.messages);
  session.history = loaded.history ?? null;
  session.historyOffset=olderOffset;
  return true;
}
async function loadMoreSavedSessions() {
  if (!native || transport !== 'live') {
    showAllSessions = !showAllSessions;
    sessionsVisibleLimit = showAllSessions ? state.sessions.length : 8;
    renderSessions();
    return;
  }
  const savedCount = state.sessions.filter(s => s.saved).length;
  if (savedSessionList.total > savedCount) {
    const saved = await native.listSessions({limit: savedSessionList.limit, offset: savedCount});
    for (const item of saved.sessions ?? []) {
      if (state.sessions.some(session => session.babelSessionId === item.id)) continue;
      state.sessions.push({ id: id(), title: item.title || 'Saved chat', messages: [], babelSessionId: item.id, saved: true, messageCount: item.messages });
    }
    savedSessionList.total = saved.total ?? savedSessionList.total;
    sessionsVisibleLimit = state.sessions.length;
    showAllSessions = true;
    renderSessions();
    return;
  }
  showAllSessions = !showAllSessions;
  sessionsVisibleLimit = showAllSessions ? state.sessions.length : 8;
  renderSessions();
}
$('.skip-link').addEventListener('click',event=>{event.preventDefault();$('#composer-input').focus();});
function updateClock(){ $('#clock').textContent=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); }

$('#quick-actions').innerHTML = [['new-session','new','New session'],['open-file','file','Open file'],['search','search','Search'],['run-tests','test','Run tests'],['git-status','git','Git status'],['settings','settings','Settings']].map(([action,symbol,label])=>`<button class="quick-action" data-action="${action}">${icon(symbol)}<span>${label}</span></button>`).join('');
document.addEventListener('click',async event=>{
  const button=event.target.closest('button[data-action]'); if(!button||button.disabled)return;
  const a=button.dataset.action;
  if(a==='refresh-models')return;
  if(a==='mode')setMode(button.dataset.mode);
  else if(a==='model'||a==='select-dialog-model'){if(activeRun){toast('Wait for the active response before changing models.');return;}if(native){if(button.dataset.model){state.model=button.dataset.model;liveModel='';renderControls();}else providerCredentialsDialog();}}
  else if(a==='models')modelsDialog();
  else if(a==='new-session')newSession();
  else if(a==='search-archive-hit'){
    if(activeRun){toast('Wait for the active run before switching sessions.');return;}
    let session=state.sessions.find(item=>item.babelSessionId===button.dataset.session);
    if(!session){session={id:id(),title:button.dataset.title||'Saved chat',messages:[],babelSessionId:button.dataset.session,saved:true};state.sessions.push(session);}
    try{
      await openSavedSession(session,{olderOffset:Number(button.dataset.offset),forceReload:true});
      selectSession(session);persist(false);closeDialog();renderAll(true);$('.workspace').classList.remove('show-left');
      const entries=[...document.querySelectorAll('#conversation .message')];
      const target=button.dataset.sourceEventId?entries.find(entry=>entry.dataset.sourceEventId===button.dataset.sourceEventId):entries[Number(button.dataset.messageIndex)-(session.history?.windowStart??0)];
      if(!target){toast('The matching archive entry moved. Search again to refresh its location.');return;}
      if(target){target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'center'});}
      announce('Opened matching conversation message.');
      const matchOffset=Number(button.dataset.matchOffset);
      const matchedMessage=session.messages[entries.indexOf(target)];
      if(matchOffset>=250000||matchedMessage?.fullActivityAvailable)await showSavedMessage(session.babelSessionId,Number(button.dataset.messageIndex),Math.floor(matchOffset/250000)*250000,button.dataset.sourceEventId);
    }catch(error){toast(error.message);}
  }
  else if(a==='view-full-message')await showSavedMessage(activeSession()?.babelSessionId,Number(button.dataset.messageIndex),0,button.dataset.sourceEventId);
  else if(a==='message-section')await showSavedMessage(button.dataset.session,Number(button.dataset.messageIndex),Number(button.dataset.offset),button.dataset.sourceEventId);
  else if(a==='session'||a==='search-session'){
    if(activeRun){toast('Wait for the active run before switching sessions.');return;}
    selectSession(state.sessions.find(session=>session.id===button.dataset.id));
    try{await openSavedSession(activeSession(), {olderOffset:activeSession().historyOffset??0,forceReload: true});}catch(err){toast(err.message);}
    persist(false);closeDialog();renderAll(true);$('.workspace').classList.remove('show-left');
  }
  else if(a==='show-more'){try{await loadMoreSavedSessions();}catch(err){toast(err.message);}}
  else if(a==='load-older-messages'){const session=activeSession(); if(!session?.babelSessionId || session.history?.tailOnly){toast('Earlier messages are not available for this large transcript tail window.');return;} const step=session.history?.messageLimit ?? 150; const next=(session.history?.olderOffset ?? 0)+step; try{await openSavedSession(session,{olderOffset:next, forceReload:true}); persist(); renderAll(true);}catch(err){toast(err.message);}}
  else if(a==='load-latest-messages'){const session=activeSession(); if(!session?.babelSessionId){return;} try{await openSavedSession(session,{olderOffset:0, forceReload:true}); persist(); renderAll(true);}catch(err){toast(err.message);}}
  else if(a==='start-remote-bridge'){try{if(activeRun){toast('Stop the active run before starting the remote bridge.');return;} await native.startRemoteBridge({port:4545}); nativeInfo=await native.getInfo(); settingsDialog(); toast('Remote bridge starting on loopback.');}catch(err){toast(err.message);}}
  else if(a==='stop-remote-bridge'){try{await native.stopRemoteBridge(); nativeInfo=await native.getInfo(); settingsDialog(); toast('Remote bridge stopped. Local runs are available again.');}catch(err){toast(err.message);}}
  else if(a==='folder')await toggleFolder(button.dataset.path);
  else if(a==='file'||a==='search-file')await openFile(button.dataset.path);
  else if(a==='diff')await openDiff(button.dataset.path);
  else if(a==='open-file'||a==='search')searchDialog();
  else if(a==='expand-tool'){const key=button.dataset.id;const top=$('#conversation').scrollTop;if(expandedTools.has(key))expandedTools.delete(key);else expandedTools.add(key);renderConversation();$('#conversation').scrollTop=top;document.querySelector(`[data-action="expand-tool"][data-id="${CSS.escape(key)}"]`)?.focus({preventScroll:true});}
  else if(a==='run-tests'){draft('Run the project tests and summarize the results.');await sendMessage();}
  else if(a==='git-status'){draft('Inspect the Git status and summarize the current changes.');await sendMessage();}
  else if(a==='draft')draft(button.dataset.text);
  else if(a==='settings')settingsDialog();
  else if(a==='connection')connectionDialog();
  else if(a==='configure-provider')providerCredentialsDialog();
  else if(a==='prepare-sandbox')await configureSandboxFromDialog(true);
  else if(a==='save-sandbox')await configureSandboxFromDialog(false);
  else if(a==='save-provider-credential')await saveProviderFromDialog(button);
  else if(a==='refresh-diagnostics'){try{nativeInfo=await native.refreshDiagnostics();connectionError='';await enableLive();renderControls();connectionDialog();}catch(err){connectionError='Connection failed. Recheck setup after repairing the installation.';renderControls();connectionDialog();}}
  else if(a==='check-update')await checkForUpdates();
  else if(a==='update-cli')await runUpdateCli();
  else if(a==='open-project')await chooseProject();
  else if(a==='trust-project'||a==='revoke-trust'){
    try{
      nativeInfo=await (a==='trust-project'?native.trustProject():native.revokeProjectTrust());
      if(a==='revoke-trust'){
        files=[];renderTree();
        if(activeRun){activeRun.stopping=true;activeRun.message.pendingApproval='';activeRun.message.approval=null;renderConversation();}
      }else if(nativeInfo.projectAuthority?.trusted){files=await native.listDirectory('.');renderTree();}
      renderControls();connectionDialog();
    }catch(err){toast(err.message);}
  }
  else if(a==='choose-cli'){try{const info=await native.chooseCli();if(info)nativeInfo=info;connectionDialog();}catch(err){toast(err.message);}}
  else if(a==='use-live'){try{await enableLive();}catch(err){toast(err.message);}}
  else if(a==='close-dialog')closeDialog();
  else if(a==='approve-run'||a==='deny-run'){
    const run=activeRun,approval=run?.message.approval;
    if(!run||!approval||(a==='approve-run'&&!run.message.approvalCommand))return;
    button.disabled=true;
    try{
      const result=await native?.decide?.({runId:run.runId,decision:a==='approve-run'?'allow_once':'deny',approval});
      if(activeRun?.runId!==run.runId)return;
      if(!Object.keys(approval).every(key=>run.message.approval?.[key]===approval[key]))return;
      run.message.approval=null;
      if(result?.accepted)run.message.pendingApproval='';
      else toast('This approval expired or was superseded. No new authority was granted.');
    }catch{toast('Could not deliver the approval reply. Recheck the active request before retrying.');}
    finally{renderConversation();}
  }
  else if(a==='stop')stopRun();
  else if(a==='emergency-host-stop')void emergencyHostStopRun();
  else if(a==='toggle-left')$('.workspace').classList.toggle('show-left');
  else if(a==='toggle-right')$('.workspace').classList.toggle('show-right');
  else if(a==='copy-message'){try{const message=activeSession().messages[Number(button.dataset.index)];if(!message?.text||message.status==='running')return;if(!native?.copyText)throw new Error('Clipboard unavailable');await native.copyText(message.text);toast('Message copied.');}catch{toast('Clipboard unavailable. Select and copy the message text.');}}
  else if(a==='about')openDialog('ABOUT BABEL',`<div class="about-brand"><img src="${LOGO}" alt=""><div><h3>BABEL</h3><p class="muted">Run. Verify. Understand.</p></div></div><p>A desktop workspace for the Babel coding-agent harness.</p><p class="muted">Babel CLI runs each task, requests approvals, and reports its verification results here.</p><div class="dialog-actions"><button class="button" data-action="connection">Connection details</button><button class="button" data-action="settings">Settings</button></div>`);
  else if(a==='repo'){if(native){await native.openRepository();}else{openDialog('BABEL REPOSITORY','<p>The canonical source repository is:</p><p><a href="https://github.com/gthgomez/Babel" target="_blank" rel="noopener noreferrer">github.com/gthgomez/Babel</a></p><p class="fine-print">Open the repository to read the source and documentation.</p>');}}
});
$('#composer-form').addEventListener('submit',ev=>{ev.preventDefault();sendMessage();});
$('#composer-input').addEventListener('input',()=>{resizeComposer();persist();});
$('#conversation').addEventListener('scroll',()=>{const session=activeSession();if(session)session.scrollTop=$('#conversation').scrollTop;});
window.addEventListener('resize',positionToast);
$('#composer-input').addEventListener('keydown',ev=>{if(ev.key==='Enter'&&!ev.shiftKey&&!ev.isComposing&&!ev.repeat&&ev.keyCode!==229){ev.preventDefault();sendMessage();}});
document.addEventListener('keydown',ev=>{
  if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='k'){ev.preventDefault();searchDialog();}
  else if((ev.ctrlKey||ev.metaKey)&&ev.altKey&&ev.key.toLowerCase()==='n'){ev.preventDefault();newSession();}
  else if(ev.altKey&&['1','2','3'].includes(ev.key)&&!$('#dialog').open){ev.preventDefault();setMode(MODE_OPTIONS[Number(ev.key)-1].id);}
  else if(ev.key==='Escape'&&!$('#dialog').open){$('.workspace').classList.remove('show-left','show-right');}
});
try{if(localStorage.getItem('babel-motion')==='reduce')document.body.classList.add('reduce-motion');}catch{}
if(native){native.onPrepareDraftClose?.(async token=>{persist();const saved=await flushComposerDrafts();await native.completeDraftClose?.({token,saved});});native.getInfo().then(async info=>{
  nativeInfo=info;await enableLive();renderControls();
  if(!info?.ready)connectionDialog();
}).catch(()=>{connectionError='Harness connection failed. Open Setup and recheck the installation.';renderControls();connectionDialog();});native.onEvent(handleNativeEvent);native.onUpdateEvent?.(event=>{updatePhase=`${event.phase}: ${event.status}`;renderRuntime();});}
setInterval(updateClock,30000);
renderAll(true);

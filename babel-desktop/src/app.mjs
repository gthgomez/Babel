import { escapeHtml, contextPercent, normalizeEvent, rememberChange, sessionIdFromResult, validPreview, absorbFileChange, reviewFromResult, liveModelFromResult, liveRequestTokens, toolsFromResult, verifiedStatus } from './core.mjs';
import { icon } from './icons.mjs';
import { MODE_OPTIONS, MODEL_OPTIONS, TOOL_OPTIONS, FINDINGS, SOLUTIONS, PREVIEW_FILES, createReference, REFERENCE_PROMPT, REFERENCE_INTRO, REFERENCE_SUMMARY, REFERENCE_TOOLS } from './fixtures.mjs';

const LOGO = '__LOGO__';
const STORAGE_KEY = 'babel-north-star-preview-v1';
const $ = selector => document.querySelector(selector);
const e = escapeHtml;
let saved = null;
try { const text = localStorage.getItem(STORAGE_KEY); if (text && text.length < 3000000) saved = JSON.parse(text); } catch {}
let state = validPreview(saved) ? saved : createReference();
state.model = MODEL_OPTIONS.includes(state.model) ? state.model : MODEL_OPTIONS[0];
let transport = 'preview';
let showAllSessions = false;
let expandedFolders = new Set(['.']);
let expandedTools = new Set();
let activeFile = '';
let files = structuredClone(PREVIEW_FILES);
let projectName = 'babel';
let tools = Object.fromEntries(TOOL_OPTIONS.map(t => [t, true]));
let activeRun = null;
let toastTimer;
let focusBeforeDialog = null;
let nativeInfo = null;
let liveModel = '';
let liveTokens = null;
let changedFiles = [];
let updatePhase = '';
const native = window.babelDesktop;
const id = () => crypto.randomUUID ? crypto.randomUUID() : `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const activeSession = () => state.sessions.find(s => s.id === state.activeId) ?? state.sessions[0];

function persist() {
  if (transport !== 'preview') return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { toast('Preview history could not be saved in this browser.'); }
}
function toast(message) {
  const target = $('#toast');
  target.textContent = message;
  target.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => target.classList.remove('visible'), 4000);
}
function announce(message) { $('#live-announcement').textContent = message; }
function setMode(mode) {
  if (!MODE_OPTIONS.some(m => m.id === mode)) return;
  if (activeRun) { toast('Wait for the active response before changing modes.'); return; }
  state.mode = mode; persist(); renderControls();
  announce(`${mode} mode selected${transport === 'preview' ? ' in preview' : ''}.`);
}
function renderTabs() {
  $('#top-tabs').innerHTML = MODE_OPTIONS.map(m => `<button class="top-tab ${state.mode === m.id ? 'active' : ''}" data-action="mode" data-mode="${m.id}" aria-pressed="${state.mode === m.id}" title="${m.label} · ${m.description} (Alt+${MODE_OPTIONS.indexOf(m)+1})"><span class="tab-bracket">[ </span>${m.label}<span class="tab-bracket"> ]</span></button>`).join('');
}
function renderControls() {
  renderTabs();
  $('#mode-controls').innerHTML = MODE_OPTIONS.map(m => `<button class="mode-option ${state.mode === m.id ? 'selected' : ''}" data-action="mode" data-mode="${m.id}" aria-pressed="${state.mode === m.id}" ${activeRun ? 'disabled' : ''}><span class="radio-dot"></span><span class="mode-name">${m.label}</span><span class="mode-description">${m.description}</span></button>`).join('');
  const liveModelLabel = liveModel || 'Configured model';
  const models = transport === 'preview' ? MODEL_OPTIONS : [liveModelLabel];
  $('#model-controls').innerHTML = models.map(m => `<button class="model-option ${(transport === 'live' || state.model === m) ? 'selected' : ''}" data-action="model" data-model="${e(m)}" aria-pressed="${transport === 'live' || state.model === m}" ${transport === 'live' ? 'disabled' : ''} title="${transport === 'preview' ? 'Reference model option; no provider is connected' : 'The existing Babel configuration owns model routing'}"><span class="radio-dot"></span>${e(m)}</button>`).join('');
  $('.more-models').hidden = transport === 'live';
  $('.preview-model-dot').style.background = transport === 'live' ? 'var(--muted)' : '';
  $('#top-model').textContent = transport === 'preview' ? state.model : liveModelLabel;
  $('#tool-controls').innerHTML = TOOL_OPTIONS.map(t => `<button class="tool-toggle" role="switch" aria-checked="${transport === 'preview' && tools[t]}" aria-label="${e(t)}${transport === 'preview' ? ' preview state' : ' controlled by Babel'}" data-action="tool" data-tool="${e(t)}" ${transport === 'live' ? 'disabled' : ''} title="${transport === 'preview' ? 'Visual preview only; this is not an execution permission' : 'Babel decides which tools run for this task'}"><span class="status-dot"></span><span>${e(t)}</span><span class="tool-on"><span class="status-dot"></span>${transport === 'live' ? 'CLI' : tools[t] ? 'On' : 'Off'}</span></button>`).join('');
  const percent = transport === 'preview' ? contextPercent(42318,112000) : null;
  $('#top-context').textContent = percent == null ? '—' : `${percent}%`;
  $('#context-value').textContent = percent == null ? '—' : `${percent}%`;
  $('#context-fill').style.width = percent == null ? '0%' : `${percent}%`;
  $('#context-meter').setAttribute('aria-label', transport === 'preview' ? 'Reference context usage' : 'Context usage not reported by CLI');
  if (percent == null) $('#context-meter').removeAttribute('aria-valuenow'); else $('#context-meter').setAttribute('aria-valuenow',String(percent));
  $('#token-count').textContent = transport === 'preview' ? '42,318 / 112,000 tokens' : (liveTokens == null ? 'Not reported by CLI' : `${Number(liveTokens).toLocaleString('en-US')} tokens in the latest request`);
  $('#preview-badge').textContent = transport === 'preview' ? 'REFERENCE PREVIEW' : 'BABEL CLI';
  renderRuntime();
  renderStatus();
}
function shortSha(sha) { return typeof sha === 'string' && sha ? sha.slice(0, 12) : 'unknown'; }
function runtimeUpdateText(update) {
  const u = update ?? {state:'unchecked'};
  const name = u.channel === 'release' ? 'Release' : u.channel === 'development' ? 'Source' : 'Update';
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
    runtimeRow('Readiness', engine.readiness?.ready ? 'Ready' : 'Not ready'),
    runtimeRow('Update', runtimeUpdateText(update), update.state === 'available' ? 'warn' : ''),
    updatePhase ? `<p class="fine-print">${e(updatePhase)}</p>` : '',
    (update.state === 'error' || update.state === 'unsupported') ? `<p class="fine-print">${e(update.detail)}</p>` : ''
  ].join('');
  checkButton.textContent = engine.origin === 'bundled' ? 'Check for updates' : 'Check for CLI updates';
  setButtons(true, engine.origin === 'official' || engine.origin === 'advanced');
}
function renderStatus(status) {
  const msg = activeSession().messages.filter(m => m.role === 'assistant').at(-1);
  const s = status ?? (activeRun ? 'running' : msg?.status ?? 'ready');
  const names = {running:transport === 'preview' ? 'Previewing' : 'Running',failed:'Failed',blocked:'Blocked',cancelled:'Stopped',complete:transport === 'preview' ? 'Preview' : 'Verified',no_change:'No change',unverified:'Unverified',ready:transport === 'preview' ? 'Preview' : 'Ready'};
  $('#main-status').textContent = names[s] ?? (transport === 'preview' ? 'Preview' : 'Ready');
  $('#main-status-dot').className = `status-dot ${['failed','blocked'].includes(s) ? s : ''}`;
  $('.status-main').className = `status-main ${['failed','blocked'].includes(s) ? s : ''}`;
  const changedNote = transport === 'live' && changedFiles.length ? ` ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}.` : '';
  const liveRunning = activeRun?.stopping ? 'Stopping the Babel CLI.' : (messageHasWork(msg) ? `Babel CLI is working on this task.${changedNote}` : 'Starting the Babel CLI.');
  const detail = transport === 'preview' ? (s === 'running' ? 'Simulated stream · no provider call.' : s === 'failed' ? 'Example failure · no tools executed.' : s === 'cancelled' ? 'Preview stream stopped.' : 'Sample session · no engine connected.') : s === 'running' ? liveRunning : s === 'unverified' ? 'Run ended; verification not established.' : s === 'failed' ? 'See the run details in the conversation.' : s === 'blocked' ? 'Babel is waiting for a decision.' : `Connected to the Babel CLI.${changedNote}`;
  $('#status-detail').textContent = detail;
  $('#send-button').disabled = Boolean(activeRun);
  $('#composer-input').disabled = Boolean(activeRun);
  $('.stop-button').hidden = !activeRun;
  if (activeRun) $('.composer-hints').style.display = 'none'; else $('.composer-hints').style.removeProperty('display');
}
function renderSessions() {
  const visible = showAllSessions ? state.sessions : state.sessions.slice(0,8);
  $('#sessions').innerHTML = visible.map(s => `<button class="session-button ${s.id === state.activeId ? 'active' : ''}" data-action="session" data-id="${e(s.id)}" aria-current="${s.id === state.activeId ? 'page' : 'false'}" title="${e(s.title)}${transport === 'preview' ? ' · local preview' : ' · one-shot run history'}"><span>${e(s.title)}</span></button>`).join('');
  $('#show-more').hidden = state.sessions.length <= 8;
  $('#show-more').textContent = showAllSessions ? 'Show less...' : 'Show more...';
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
  const changed = transport === 'live' && changedFiles.length ? `<div class="changed-files"><div class="section-heading"><h2>CHANGED</h2></div>${changedFiles.map(file => `<button class="tree-row tree-file" data-action="file" data-path="${e(file.path)}" title="${e(file.path)}">${icon('code')}<span class="tree-label">${e(file.path)}</span>${file.additions == null ? '' : `<span class="tool-meta">+${file.additions} -${file.deletions ?? 0}</span>`}</button>`).join('')}</div>` : '';
  $('#project-tree').innerHTML = `${changed}<button class="tree-row tree-root" data-action="folder" data-path="." aria-expanded="${expandedFolders.has('.')}">${icon(expandedFolders.has('.') ? 'down':'chevron')}${icon('folderOpen')}<span class="tree-label">${e(projectName)}</span></button>${expandedFolders.has('.') ? `<div class="tree-children root-children">${treeMarkup(files)}</div>` : ''}`;
}
function toolRows(rows) {
  return `<div class="tool-feed">${rows.map(t => `<div class="tool-item"><button class="tool-row ${e(t.status)}" data-action="expand-tool" data-id="${e(t.id)}" aria-expanded="${expandedTools.has(t.id)}" title="Expand ${e(t.label)}">${icon('chevron')}<span class="tool-label">${t.action ? `<span class="tool-action">${e(t.action)}</span><span class="tool-path">${e(t.path)}</span>` : `<span class="tool-path">${e(t.label)}</span>`}</span><span class="tool-meta"><span>${e(t.meta ?? (t.status === 'running' ? 'running...' : ''))}</span>${t.duration ? `<span class="duration-dot">•</span><span class="duration">${e(t.duration)}</span>` : ''}</span><span class="tool-status ${e(t.status)}">${t.status === 'complete' ? icon('check') : t.status === 'failed' ? icon('close') : ''}</span></button>${expandedTools.has(t.id) ? `<pre class="tool-detail">${e(t.detail ?? 'No additional output was reported.')}</pre>` : ''}</div>`).join('')}</div>`;
}
function card(title, symbol, items) {
  return `<section class="result-card"><h3 class="card-title">${icon(symbol)}${e(title)}</h3><ol>${items.map(x=>`<li>${e(x)}</li>`).join('')}</ol></section>`;
}
function referenceMarkup() {
  return `<article class="message user-message"><div class="message-label">YOU</div><div class="message-body message-text">${e(REFERENCE_PROMPT)}</div></article><article class="message assistant-message reference-answer"><img class="assistant-avatar" src="${LOGO}" alt=""><div class="message-label">BABEL</div><div class="message-body"><div class="message-text">${e(REFERENCE_INTRO)}</div>${toolRows(REFERENCE_TOOLS)}<div class="message-text">${e(REFERENCE_SUMMARY)}</div>${card('KEY FINDINGS','info',FINDINGS)}${card('PROPOSED SOLUTION','wrench',SOLUTIONS)}<p class="closing-message">Would you like me to implement this now?</p></div></article>`;
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
      parts.push(`<details class="thought-note"><summary>Thinking</summary><pre class="tool-detail">${e(block.text)}</pre></details>`);
      return;
    }
    const caret = m.status === 'running' && index === blocks.length - 1 ? '<span class="stream-caret"></span>' : '';
    parts.push(`<div class="message-text">${e(block.text)}${caret}</div>`);
  });
  flush();
  return parts.join('');
}
function messageMarkup(m, index) {
  if (m.role === 'user') return `<article class="message user-message"><div class="message-label">YOU</div><div class="message-body message-text">${e(m.text)}</div></article>`;
  const approval = m.pendingApproval ? `<div class="approval-card"><p>${e(m.pendingApproval)}</p><div class="dialog-actions"><button class="button primary" data-action="approve-run">Allow</button><button class="button" data-action="deny-run">Deny</button></div></div>` : '';
  const review = m.review?.reasons?.length ? card(m.review.title || 'REVIEW', 'info', m.review.reasons) : '';
  const evidence = m.result && ['failed','blocked','unverified'].includes(m.status) ? `<details class="raw-result"><summary>CLI result / evidence</summary><pre class="tool-detail">${e(JSON.stringify(m.result,null,2))}</pre></details>` : '';
  return `<article class="message assistant-message"><img class="assistant-avatar" src="${LOGO}" alt=""><div class="message-label">BABEL</div><div class="message-body">${assistantBody(m)}${review}${approval}${m.status && m.status !== 'running' ? `<div class="message-status ${e(m.status)}">${transport === 'preview' ? 'PREVIEW · ' : ''}${e(({complete:'Response complete',no_change:'No change required',failed:'Run failed',blocked:'Approval or environment action required',cancelled:'Response stopped',unverified:'Run ended · not verified'})[m.status] ?? m.status)}</div>` : ''}${evidence}</div><div class="message-actions"><button data-action="copy-message" data-index="${index}">${icon('copy')} Copy</button></div></article>`;
}
function renderConversation(forceBottom = false, reset = false) {
  const scroller = $('#conversation');
  const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 90;
  const previousTop = scroller.scrollTop;
  const session = activeSession();
  if (!session.fixture && session.messages.length === 0) {
    scroller.innerHTML = `<div class="empty-state"><img src="${LOGO}" alt=""><h1>Run. Verify. Understand.</h1><p>${transport === 'preview' ? 'A clear view of your agent’s work.<br>Start a conversation to try the North Star interface.' : 'Babel CLI is connected.<br>Send a task and the reply, tool rows, and status fill in here.'}</p><div class="empty-actions"><button data-action="draft" data-text="Investigate the review timeout behavior.">Investigate a problem</button><button data-action="draft" data-text="Review the current project architecture.">Explore the project</button></div><div class="preview-note">${icon('info')}${transport === 'preview' ? 'Interactive preview · no model or tool execution' : 'Live session · Babel CLI owns the work'}</div></div>`;
  } else scroller.innerHTML = `${session.fixture ? referenceMarkup() : ''}${session.messages.map(messageMarkup).join('')}`;
  if (reset) scroller.scrollTop = 0;
  else if (forceBottom || atBottom) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = previousTop;
}
function renderAll(reset = false) {
  renderSessions(); renderTree(); renderControls(); renderConversation(false,reset); updateClock();
}
function newSession() {
  const session = {id:id(),title:'New session',messages:[]};
  state.sessions.unshift(session);
  if (state.sessions.length > 60) state.sessions.pop();
  state.activeId = session.id;
  persist(); renderAll(true); $('#composer-input').value = ''; resizeComposer(); $('#composer-input').focus();
  $('.workspace').classList.remove('show-left');
}
function draft(text) { closeDialog(); $('#composer-input').value = text; resizeComposer(); $('#composer-input').focus(); }
function resizeComposer() {
  const input = $('#composer-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(150,input.scrollHeight)}px`;
  $('.composer').classList.toggle('expanded',input.scrollHeight > 55 || input.value.length > 45);
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
$('#dialog').addEventListener('close',()=>focusBeforeDialog?.focus?.());
$('#dialog').addEventListener('click',ev=>{if(ev.target === $('#dialog')) { const r=ev.target.getBoundingClientRect(); if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom) closeDialog(); }});

function connectionDialog() {
  if(nativeInfo?.packaged){
    const d=nativeInfo.diagnostics;
    openDialog('BABEL SETUP',`<p>Babel Desktop includes its CLI, Node runtime, and prompt assets. Choose a project when you are ready.</p><div class="settings-row"><span>Bundled runtime</span><span>${nativeInfo.officialCliReady?'Available':'Missing files — extract the complete ZIP again'}</span></div><div class="settings-row"><span>Provider</span><span>${d?.provider==='configured'?'Credential present; authentication unverified':'No cloud credential detected; local routes use CLI configuration'}</span></div><div class="settings-row"><span>Docker / safe_repo</span><span>${d?.docker==='available'?'Available':'Unavailable — start Docker before running tasks'}</span></div><div class="settings-row"><span>Project</span><span>${e(nativeInfo.projectName??'Not selected')}</span></div><h3>FIRST LAUNCH</h3><p>Choose a supported provider and save its API key using <strong>Configure provider</strong>. The default destination is Babel's private profile, not the project repository.</p><pre>${e(nativeInfo.configDirectory??'Configuration directory unavailable')}</pre><p>Other supported provider settings belong in the same file. Credential-free local providers do not need a cloud key; Babel validates the selected route when a task starts. Model reference controls do not configure a provider. Desktop does not import credentials from other apps or checkouts. Environment credentials you explicitly supply are also accepted by Babel.</p><p>Install and start Docker separately. The default <code>safe_repo</code> profile requires it; Desktop does not start Docker or switch to unrestricted host execution.</p>${d?.error?`<p>${e(d.error)}</p>`:''}<div class="dialog-actions"><button class="button" data-action="refresh-diagnostics">Recheck setup</button><button class="button" data-action="configure-provider">Configure provider</button><button class="button" data-action="open-project">Open project</button><button class="button primary" data-action="use-live" ${nativeInfo.ready&&d?.ready?'':'disabled'}>Use Babel Harness</button></div><p class="fine-print">Diagnostics make no model calls. A present credential has not been authenticated. See INSTALL.md and use Babel Harness.cmd doctor --json for local details.</p>`);
    return;
  }
  openDialog('BABEL CONNECTION',`<div class="connection-label">${icon('terminal')}${transport === 'preview' ? 'Reference preview' : 'Babel CLI'}</div><p>${transport === 'preview' ? 'This is a working UI preview, not a running agent. The initial conversation, model names, tool activity, and token count reproduce the supplied reference.' : 'Tasks run through the Babel CLI. Replies, tool rows, and status on this screen come from that run.'}</p><p>${native ? 'Startup uses the sibling babel-cli build when that file exists. Open a project, then send a task. Another CLI entry is an advanced setting.' : 'The browser preview has no access to your CLI. Use the Electron app for a live run. No keys are requested or stored here.'}</p>${nativeInfo ? `<div class="settings-row"><span>Official CLI</span><span class="muted">${nativeInfo.officialCliReady === true ? e(nativeInfo.officialCliLabel || 'babel-cli/dist/index.js') : nativeInfo.officialCliReady === false ? 'Not built' : 'Not reported'}</span></div><div class="settings-row"><span>CLI</span><span class="muted">${e(nativeInfo.cliName ?? 'Not selected')}</span></div><div class="settings-row"><span>Project</span><span class="muted">${e(nativeInfo.projectName ?? 'Not selected')}</span></div>` : ''}<div class="dialog-actions">${native ? `<button class="button" data-action="choose-cli">Advanced: other CLI</button><button class="button" data-action="configure-provider">Configure provider</button><button class="button" data-action="open-project">Open project</button><button class="button primary" data-action="use-live" ${nativeInfo?.ready ? '' : 'disabled'}>Use Babel Harness</button>` : '<button class="button primary" data-action="close-dialog">Continue preview</button>'}</div><p class="fine-print">File changes and commands follow Babel's own approval rules. Allow or deny them in this window. Stop ends the current run.</p>`);
}
function providerCredentialsDialog() {
  if(!native) {toast('Configure credentials in the installed or source Electron application.');return;}
  const hasProject=Boolean(nativeInfo?.projectName);
  const projectOption=hasProject?'<option value="project">Selected project .env (explicit opt-in)</option>':'';
  openDialog('CONFIGURE AI PROVIDER',`<p>Save your provider key in Babel's private profile (recommended). Project-local .env is optional, requires an explicitly selected Git-ignored project, and may be read by project tools.</p>
    <label class="credential-label" for="credential-provider">Provider</label>
    <select class="credential-control" id="credential-provider">
      <option value="deepseek">DeepSeek</option>
      <option value="openrouter">OpenRouter</option>
      <option value="deepinfra">DeepInfra</option>
    </select>
    <label class="credential-label" for="credential-key">API key</label>
    <input class="credential-control" id="credential-key" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" placeholder="Paste your provider API key">
    <label class="credential-label" for="credential-scope">Save to</label>
    <select class="credential-control" id="credential-scope">
      <option value="private">Private Babel profile (recommended)</option>
      ${projectOption}
    </select>
    <p class="fine-print">Project storage is refused unless .env is Git-ignored and untracked. Existing provider values are not overwritten. Keys are plaintext .env values with restricted access, not OS-keychain secrets. Credentials are never saved in UI preferences or chat history.</p>
    <div class="dialog-actions"><button class="button primary" data-action="save-provider-credential">Save credential</button><button class="button" data-action="close-dialog">Cancel</button></div>`,'#credential-key');
}
async function saveProviderFromDialog(button) {
  const keyInput=$('#credential-key');
  const provider=$('#credential-provider')?.value;
  const scope=$('#credential-scope')?.value;
  if(!keyInput?.value){toast('Enter a provider API key.');return;}
  const apiKey=keyInput.value;
  keyInput.value=''; // Clear the DOM before crossing the narrow native bridge.
  button.disabled=true;
  try {
    const result=await native.saveProviderCredential({provider,apiKey,scope});
    nativeInfo=await native.refreshDiagnostics();
    closeDialog();
    toast(result.scope==='private'?'Credential saved in private Babel configuration.':'Project credential saved with explicit opt-in.');
  } catch(error) {
    toast('Credential setup: '+String(error?.message??'could not save safely'));
  } finally {
    button.disabled=false;
  }
}

function settingsDialog() {
  openDialog('SETTINGS',`<h3>WORKSPACE</h3><div class="settings-row"><span>Provider credentials</span><button class="button" data-action="configure-provider">Configure provider</button></div><div class="settings-row"><span>Runtime</span><button class="button" data-action="connection">${transport === 'preview' ? 'Reference preview' : 'Babel CLI'} ${icon('arrow')}</button></div><div class="settings-row"><span>Visual reference</span><span class="muted">BabelTuiNorthStar.png</span></div><div class="settings-row"><label><input id="reduce-motion" type="checkbox" ${document.body.classList.contains('reduce-motion') ? 'checked' : ''}> Reduce motion</label><span class="muted">Interface animations</span></div><h3>KEYBOARD</h3><div class="settings-row"><span>Send message</span><code>Ctrl + Enter</code></div><div class="settings-row"><span>Newline</span><code>Shift + Enter</code></div><div class="settings-row"><span>Search sessions and files</span><code>Ctrl + K</code></div><div class="settings-row"><span>New session</span><code>Ctrl + Alt + N</code></div><div class="settings-row"><span>Switch Chat / Plan / Deep</span><code>Alt + 1 / 2 / 3</code></div>${transport === 'preview' ? '<h3>PREVIEW</h3><p class="muted">Preview conversations are stored only in this browser. They are not Babel runtime sessions.</p><div class="dialog-actions"><button class="button" data-action="error-demo">Show error state</button><button class="button danger" data-action="reset-preview">Reset preview history</button></div>' : ''}`);
  $('#reduce-motion').addEventListener('change',ev=>{document.body.classList.toggle('reduce-motion',ev.target.checked);try{localStorage.setItem('babel-preview-motion',ev.target.checked?'reduce':'normal');}catch{}});
}
function modelsDialog() {
  openDialog('MODEL',`<p class="muted">These options reproduce the North Star reference. Selecting one changes the preview, not a provider configuration.</p><div class="search-results">${MODEL_OPTIONS.map(m=>`<button class="search-result" data-action="select-dialog-model" data-model="${e(m)}"><span class="radio-dot"></span>${e(m)}<small>${state.model===m?'Selected':'Reference option'}</small></button>`).join('')}</div><p class="fine-print">The native adapter intentionally defers model routing to your existing Babel configuration.</p>`);
}
function flattenFiles(nodes,parent='') { return nodes.flatMap(n=>{const p=parent?`${parent}/${n.name}`:n.name;return n.type==='folder'?flattenFiles(n.children??[],p):[{name:n.name,path:p}];}); }
function searchDialog() {
  openDialog('SEARCH',`<input class="search-input" id="search-input" type="search" placeholder="Search sessions and files..." aria-label="Search sessions and files" autocomplete="off"><div id="search-results" class="search-results"></div><p class="fine-print">Searches visible session titles and loaded project file names.</p>`,'#search-input');
  const update = ()=>{
    const q=$('#search-input').value.toLowerCase().trim();
    const sessions=state.sessions.filter(s=>s.title.toLowerCase().includes(q)).slice(0,8);
    const matches=flattenFiles(files).filter(f=>f.path.toLowerCase().includes(q)).slice(0,12);
    $('#search-results').innerHTML = sessions.map(s=>`<button class="search-result" data-action="search-session" data-id="${e(s.id)}">${icon('terminal')}<span>${e(s.title)}</span><small>Session</small></button>`).join('')+matches.map(f=>`<button class="search-result" data-action="search-file" data-path="${e(f.path)}">${icon('file')}<span>${e(f.path)}</span><small>File</small></button>`).join('') || '<p class="muted">No matches. Try another name.</p>';
  }; update(); $('#search-input').addEventListener('input',update);
}
async function openFile(path) {
  activeFile=path;renderTree();
  if (nativeInfo?.projectName && transport === 'live') {
    try { const r = await native.readFile(path); openDialog(path,`<div class="file-info"><span>READ-ONLY</span><span>${r.truncated ? 'Truncated to 256 KB' : 'Project file'}</span></div><pre>${e(r.text)}</pre>`); }
    catch(err){openDialog('FILE UNAVAILABLE',`<p>${e(err.message)}</p>`);}
  } else {
    openDialog(path,`<div class="file-info"><span>REFERENCE PREVIEW</span><span>No repository file was read</span></div><p>This file is represented in the North Star project tree. Its actual contents are not bundled with the visual reference.</p><pre>${e(path)}\n\nOpen the native application and connect a project\nto inspect real files in this panel.</pre>`);
  }
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
function stopPreview() {
  if (!activeRun) return;
  if (transport === 'live') {
    native?.cancel?.();
    activeRun.stopping = true;
    activeRun.message.stopping = true;
    activeRun.message.pendingApproval = '';
    renderConversation();
    renderControls();
    announce('Babel run stopping.');
    return;
  }
  clearInterval(activeRun.timer);
  activeRun.message.status='cancelled';activeRun=null;
  persist();renderConversation();renderControls();announce('Preview response stopped.');$('#composer-input').focus();
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
  const input=$('#composer-input');const text=input.value.trim();
  if(!text||activeRun)return;
  if(text.length>24000){toast('Please keep a single message under 24,000 characters.');return;}
  const session=activeSession();
  if(session.messages.length>145){toast('Start a new session to keep this preview responsive.');return;}
  session.messages.push({role:'user',text});
  if(session.title==='New session'||session.title==='New read-only run') session.title=text.length>27?text.slice(0,27)+'...':text;
  const message={role:'assistant',text:'',status:'running',tools:[],blocks:[]};session.messages.push(message);
  input.value='';resizeComposer();
  const runId=id();activeRun={runId,sessionId:session.id,mode:state.mode,message,timer:null};
  renderSessions();renderConversation(true);renderControls();announce(transport==='preview'?'Preview response started.':'Babel run requested.');
  if(transport==='live') {
    try {
      const result=await native.run({runId,task:text,mode:state.mode,...(state.mode==='chat'&&session.babelSessionId?{sessionId:session.babelSessionId}:{})});
      if(!result.started && activeRun?.runId===runId){message.status='cancelled';message.text='Run was not started. No model call was made.';activeRun=null;renderConversation();renderControls();}
    } catch(err){if(activeRun?.runId===runId){message.status='failed';message.text=err.message;activeRun=null;renderConversation();renderControls();}}
    return;
  }
  const response = `This is the interactive North Star preview. Your message is saved in this browser, and the ${state.mode.charAt(0).toUpperCase()+state.mode.slice(1)} controls are working.\n\nNo model was called and no repository files were read or changed. The live desktop adapter hands requests to the existing Babel CLI rather than implementing another agent.\n\nYou can switch sessions, expand the reference tool rows, browse the project tree, or open Settings to inspect the connection boundary.`;
  let pos=0;
  activeRun.timer=setInterval(()=>{
    pos+=12;message.text=response.slice(0,pos);
    if(pos>=response.length){clearInterval(activeRun.timer);message.status='complete';activeRun=null;persist();renderControls();announce('Preview response complete.');}
    if(state.activeId===session.id)renderConversation();
  },24);
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
    message.stopping=false;
    activeRun=null;
  } else if(packet.kind==='transport-error') {
    run.transportError=true;appendLiveText(message,`\n\nTransport: ${String(packet.error).slice(0,4000)}`);
  } else if(packet.kind==='event') {
    const ev=normalizeEvent(packet.event);
    if (packet.event?.type === 'file.changed') {
      const item = packet.event.item ?? {};
      changedFiles = rememberChange(changedFiles, item.path, Number(item.additions), Number(item.deletions));
      const row = absorbFileChange(message.tools, item);
      if (row && !message.tools?.includes(row)) upsertLiveTool(message, row);
    }
    if(ev.kind==='delta')appendLiveText(message,ev.text);
    else if(ev.kind==='thought' || ev.kind==='progress') appendNote(message, ev.text);
    else if(ev.kind==='start' && ev.model && ev.model !== 'default' && ev.model !== 'unknown'){liveModel=ev.model;}
    else if(ev.kind==='approval'){message.pendingApproval=ev.text;}
    else if(ev.kind==='terminal') {
      message.pendingApproval='';
      const status = verifiedStatus(ev.status, run.transportError);
      message.status=status;
      settleTools(message, status==='failed'||status==='blocked'?'failed':status==='cancelled'?'cancelled':'complete');
      if(!message.text&&ev.text)appendLiveText(message,ev.text.slice(0,250000));
      if(!message.text)appendLiveText(message,'Babel returned a structured result.');
      message.result=ev.raw;
      message.review=reviewFromResult(ev.raw);
      for (const row of toolsFromResult(ev.raw, message.tools)) upsertLiveTool(message, row);
      const resumed=sessionIdFromResult(ev.raw);
      if(resumed&&run.mode==='chat'){const owner=state.sessions.find(item=>item.id===run.sessionId);if(owner)owner.babelSessionId=resumed;}
      const reportedModel = liveModelFromResult(ev.raw);
      if (reportedModel) liveModel = reportedModel;
      const requestTokens = liveRequestTokens(ev.raw);
      if (requestTokens != null) liveTokens = requestTokens;
      if (Array.isArray(ev.raw?.changed_files)) {
        for (const path of ev.raw.changed_files) changedFiles = rememberChange(changedFiles, path, null, null);
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
    const result = await native.updateDevCli();
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
  if(activeRun){toast('Wait for the active run before switching projects.');return;}
  try{nativeInfo=await native.chooseProject();if(nativeInfo)connectionDialog();}catch(err){toast(err.message);}
}
async function enableLive() {
  if(!native||!nativeInfo?.ready||activeRun)return;
  const nextFiles=await native.listDirectory('.');
  transport='live';state={version:1,mode:'chat',model:'',sessions:[],activeId:''};
  liveModel='';liveTokens=null;changedFiles=[];
  files=nextFiles;projectName=nativeInfo.projectName;expandedFolders=new Set(['.']);
  closeDialog();newSession();
  try {
    const saved = await native.listSessions();
    for (const item of saved) {
      if (state.sessions.some(session => session.babelSessionId === item.id)) continue;
      state.sessions.push({ id: id(), title: item.title || 'Saved chat', messages: [], babelSessionId: item.id, saved: true });
    }
    renderSessions();
  } catch { /* A missing runs directory leaves the new session in place. */ }
  announce('Babel CLI connected.');
}
async function openSavedSession(session) {
  if (!session?.saved || session.messages.length || !session.babelSessionId) return;
  const loaded = await native.openSession(session.babelSessionId);
  session.messages = (loaded.messages ?? []).map(message => message.role === 'assistant'
    ? { role: 'assistant', text: message.text, status: 'complete', tools: [], blocks: [{ kind: 'text', text: message.text }] }
    : { role: 'user', text: message.text });
}
$('.skip-link').addEventListener('click',event=>{event.preventDefault();$('#composer-input').focus();});
function updateClock(){ $('#clock').textContent=transport==='preview'&&state.activeId==='reference'?'10:24 AM':new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); }

$('#quick-actions').innerHTML = [['new-session','new','New session'],['open-file','file','Open file'],['search','search','Search'],['run-tests','test','Run tests'],['git-status','git','Git status'],['settings','settings','Settings']].map(([action,symbol,label])=>`<button class="quick-action" data-action="${action}">${icon(symbol)}<span>${label}</span></button>`).join('');
document.addEventListener('click',async event=>{
  const button=event.target.closest('button[data-action]'); if(!button||button.disabled)return;
  const a=button.dataset.action;
  if(a==='mode')setMode(button.dataset.mode);
  else if(a==='model'||a==='select-dialog-model'){if(activeRun){toast('Wait for the active response before changing models.');return;}if(transport==='preview'&&MODEL_OPTIONS.includes(button.dataset.model)){state.model=button.dataset.model;persist();renderControls();if(a==='select-dialog-model')closeDialog();}}
  else if(a==='models')modelsDialog();
  else if(a==='new-session')newSession();
  else if(a==='session'||a==='search-session'){
    if(activeRun){toast('Wait for the active run before switching sessions.');return;}
    state.activeId=button.dataset.id;
    try{await openSavedSession(activeSession());}catch(err){toast(err.message);}
    persist();closeDialog();renderAll(true);$('.workspace').classList.remove('show-left');
  }
  else if(a==='show-more'){showAllSessions=!showAllSessions;renderSessions();}
  else if(a==='folder')await toggleFolder(button.dataset.path);
  else if(a==='file'||a==='search-file')await openFile(button.dataset.path);
  else if(a==='open-file'||a==='search')searchDialog();
  else if(a==='expand-tool'){const key=button.dataset.id;const top=$('#conversation').scrollTop;if(expandedTools.has(key))expandedTools.delete(key);else expandedTools.add(key);renderConversation();$('#conversation').scrollTop=top;document.querySelector(`[data-action="expand-tool"][data-id="${CSS.escape(key)}"]`)?.focus({preventScroll:true});}
  else if(a==='tool'&&transport==='preview'){tools[button.dataset.tool]=!tools[button.dataset.tool];renderControls();toast('Preview state only. No execution permissions changed.');}
  else if(a==='run-tests')draft('Run the project tests and summarize the results.');
  else if(a==='git-status')draft('Inspect the Git status and summarize the current changes.');
  else if(a==='draft')draft(button.dataset.text);
  else if(a==='settings')settingsDialog();
  else if(a==='connection')connectionDialog();
  else if(a==='configure-provider')providerCredentialsDialog();
  else if(a==='save-provider-credential')await saveProviderFromDialog(button);
  else if(a==='refresh-diagnostics'){try{nativeInfo=await native.refreshDiagnostics();connectionDialog();}catch(err){toast(err.message);}}
  else if(a==='check-update')await checkForUpdates();
  else if(a==='update-cli')await runUpdateCli();
  else if(a==='open-project')await chooseProject();
  else if(a==='choose-cli'){try{const info=await native.chooseCli();if(info)nativeInfo=info;connectionDialog();}catch(err){toast(err.message);}}
  else if(a==='use-live'){try{await enableLive();}catch(err){toast(err.message);}}
  else if(a==='close-dialog')closeDialog();
  else if(a==='approve-run'||a==='deny-run'){if(activeRun){activeRun.message.pendingApproval='';renderConversation();}await native?.decide?.(a==='approve-run'?'allow_once':'deny');}
  else if(a==='stop')stopPreview();
  else if(a==='toggle-left')$('.workspace').classList.toggle('show-left');
  else if(a==='toggle-right')$('.workspace').classList.toggle('show-right');
  else if(a==='copy-message'){try{await navigator.clipboard.writeText(activeSession().messages[Number(button.dataset.index)]?.text??'');toast('Message copied.');}catch{toast('Clipboard unavailable. Select and copy the message text.');}}
  else if(a==='reset-preview'){if(activeRun){toast('Stop the preview response first.');return;}state=createReference();files=structuredClone(PREVIEW_FILES);expandedTools.clear();expandedFolders=new Set(['.']);tools=Object.fromEntries(TOOL_OPTIONS.map(t=>[t,true]));persist();closeDialog();renderAll(true);toast('Reference preview restored.');}
  else if(a==='error-demo'){if(activeRun){toast('Stop the preview response first.');return;}activeSession().messages.push({role:'assistant',text:'Example error state — the tool could not complete.\n\nThis is a visual fixture, not an actual tool failure. No files were changed.',status:'failed',tools:[{id:id(),label:'preview · test runner',status:'failed',meta:'failed',detail:'Demonstration only. Connect Babel to display real failure details.'}]});closeDialog();persist();renderConversation(true);renderControls();}
  else if(a==='about')openDialog('ABOUT BABEL',`<div class="about-brand"><img src="${LOGO}" alt=""><div><h3>BABEL</h3><p class="muted">Run. Verify. Understand.</p></div></div><p>The North Star, made interactive. A focused desktop surface for inspectable, verifiable agent work.</p><p class="muted">This build preserves the reference layout, branding, execution rows, and control hierarchy. Babel remains the only execution engine.</p><div class="dialog-actions"><button class="button" data-action="connection">Connection details</button><button class="button" data-action="settings">Settings</button></div>`);
  else if(a==='repo'){if(native){await native.openRepository();}else{openDialog('BABEL REPOSITORY','<p>The canonical source repository is:</p><p><a href="https://github.com/gthgomez/Babel" target="_blank" rel="noopener noreferrer">github.com/gthgomez/Babel</a></p><p class="fine-print">The source package delivered with this preview is separate. No upstream files were changed.</p>');}}
});
$('#composer-form').addEventListener('submit',ev=>{ev.preventDefault();sendMessage();});
$('#composer-input').addEventListener('input',resizeComposer);
$('#composer-input').addEventListener('keydown',ev=>{if(ev.key==='Enter'&&(ev.ctrlKey||ev.metaKey)&&!ev.isComposing){ev.preventDefault();sendMessage();}});
document.addEventListener('keydown',ev=>{
  if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='k'){ev.preventDefault();searchDialog();}
  else if((ev.ctrlKey||ev.metaKey)&&ev.altKey&&ev.key.toLowerCase()==='n'){ev.preventDefault();newSession();}
  else if(ev.altKey&&['1','2','3'].includes(ev.key)&&!$('#dialog').open){ev.preventDefault();setMode(MODE_OPTIONS[Number(ev.key)-1].id);}
  else if(ev.key==='Escape'&&!$('#dialog').open){$('.workspace').classList.remove('show-left','show-right');}
});
try{if(localStorage.getItem('babel-preview-motion')==='reduce')document.body.classList.add('reduce-motion');}catch{}
if(native){native.getInfo().then(info=>{
  nativeInfo=info;renderRuntime();
  if(info?.packaged){state={version:1,mode:'chat',model:'',sessions:[],activeId:''};files=[];newSession();connectionDialog();}
}).catch(error=>toast(`Connection unavailable: ${error.message}`));native.onEvent(handleNativeEvent);native.onUpdateEvent?.(event=>{updatePhase=`${event.phase}: ${event.status}`;renderRuntime();});}
setInterval(updateClock,30000);
renderAll(true);

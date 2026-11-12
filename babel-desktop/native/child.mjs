import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { JsonlDecoder } from './stream.mjs';
import {scopedApproval,scopedApprovalReply} from '../src/core.mjs';
import {applyExecutionScopeEnvironment} from './childEnv.mjs';
import {productionNodeCliArgv} from './cli-launch.mjs';

/** The effective execution profile the Desktop launches the CLI with. */
export const EXECUTION_PROFILE = 'host_native';

// Even when display output is capped, the owned child can still ask for
// approval, acknowledge control, or report a terminal outcome. The renderer
// continues to mark a capped stream unverified because other evidence may have
// been omitted; decoding these events does not make the stream complete.
const CONTROL_EVENTS = new Set([
  'approval.required','approval.pending','approval.reconciled',
  'control.rejected','transport.disconnected',
  'run_complete','run_error','turn.completed','turn.failed','cancelled',
]);

function terminateChildTree(child) {
  if (process.platform === 'win32' && child.pid) {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkillPath = resolve(windowsRoot, 'System32', 'taskkill.exe');
    try {
      spawnSync(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 1500 });
    } catch { /* The close handler still reports the exit. */ }
  }
  try { child.kill(); } catch { /* The child may already have exited. */ }
}

/** Build the exact child environment; a legacy resume is a deliberate migration. */
export function buildChildEnvironment(base, {runId, executionScope, resumeProfileSelection}) {
  const env=applyExecutionScopeEnvironment({...base,
    BABEL_DESKTOP_IPC:'1', BABEL_DESKTOP_RUN_ID:runId, BABEL_DAEMON_ENABLED:'false',
  },executionScope);
  // Desktop always passes the effective profile explicitly; an ambient value
  // must not conflict with a recorded session policy.
  delete env['BABEL_EXECUTION_PROFILE'];
  if(resumeProfileSelection===true)env['BABEL_DESKTOP_RESUME_PROFILE_SELECTION']='explicit';
  return env;
}

/** No shell, interpolated command, automatic approval, or invented runtime flag. */
export function buildRunArgs(entry, projectRoot, {task, mode, sessionId, model,executionScope,executionProfile}) {
  const conversation=executionScope?.kind==='conversation';
  if(executionScope!==undefined&&!['project','conversation'].includes(executionScope?.kind))throw new TypeError('Invalid execution scope');
  if(executionProfile!==undefined&&!['host_native','safe_repo'].includes(executionProfile))throw new TypeError('Invalid execution profile');
  if (typeof entry !== 'string' || !isAbsolute(entry) || (conversation?projectRoot!==null:typeof projectRoot !== 'string' || !isAbsolute(projectRoot))) throw new TypeError('An absolute CLI and explicit execution scope are required');
  if(conversation&&mode!=='chat')throw new TypeError('Select a project before using this execution mode');
  if (typeof task !== 'string' || !task.trim() || task.length > 24000 || task.includes('\0')) throw new TypeError('Invalid task text');
  if (!['chat', 'plan', 'deep'].includes(mode)) throw new TypeError('Invalid Babel mode');
  const args = [entry, 'run', '--mode', mode, ...(conversation?['--execution-scope','conversation']:['--project-root',projectRoot]),
    '--output-format', 'stream-json', '--execution-profile', executionProfile ?? EXECUTION_PROFILE];
  if (sessionId != null && sessionId !== '') {
    if (typeof sessionId !== 'string' || !/^[\w-]{1,80}$/.test(sessionId)) throw new TypeError('Invalid chat session id');
    args.push('--resume-chat', sessionId);
  }
  if (model != null && model !== '') {
    if (typeof model !== 'string' || !/^[\w./:+-]{1,200}$/.test(model)) throw new TypeError('Invalid model argument');
    args.push('--model', model);
  }
  args.push('--', task);
  return args;
}

/** Owns one child process, not a Babel runtime or an agent/session store. */
export class BabelChild {
  #child = null;
  #approval = null;
  #runId = null;
  #approvalClosed = true;
  constructor({executable, entry, projectRoot,launchDirectory, env = {}, inheritEnv = true}) {
    if (!isAbsolute(executable)) throw new TypeError('The Node executable must be absolute');
    if(projectRoot===null&&(typeof launchDirectory!=='string'||!isAbsolute(launchDirectory)))throw new TypeError('Conversation launch directory must be explicit and absolute');
    this.executable = executable; this.entry = entry; this.projectRoot = projectRoot; this.launchDirectory=projectRoot??launchDirectory;this.env = env; this.inheritEnv = inheritEnv;
  }
  get busy() { return this.#child !== null; }
  get awaitingApproval() { return !this.#approvalClosed && Boolean(this.#approval && Date.parse(this.#approval.expires_at)>Date.now()); }
  start(request, onPacket) {
    if (this.busy) throw new Error('A Babel child is already running');
    if (typeof request.runId !== 'string' || !/^[\w-]{1,100}$/.test(request.runId)) throw new TypeError('Invalid run ID');
    const args = buildRunArgs(this.entry, this.projectRoot, request);
    const send = packet => onPacket({runId: request.runId, ...packet});
    let stderr = ''; let stderrBytes = 0; let stdoutBytes = 0; let displayLimited = false; let errors = 0; let terminalReceived=false;
    const report = error => { if (errors++ < 8) send({kind:'transport-error',error}); };
    this.#approval=null;this.#runId=request.runId;this.#approvalClosed=false;
    const decoder = new JsonlDecoder(event => {
      if(event.type==='approval.required'&&!this.#approvalClosed){
        const binding=scopedApproval(event.item?.approval);
        this.#approval=binding?.run_id===request.runId?binding:null;
      }
      if(['run_complete','run_error','turn.completed','turn.failed','cancelled'].includes(event.type)){terminalReceived=true;this.#approval=null;this.#approvalClosed=true;}
      if(!displayLimited || CONTROL_EVENTS.has(event.type)) send({kind:'event',event});
    }, report);
    const childEnvironment=buildChildEnvironment({
      ...(this.inheritEnv ? process.env : {}), ...this.env,
    },{runId:request.runId,executionScope:request.executionScope,resumeProfileSelection:request.resumeProfileSelection});
    const child = spawn(this.executable, productionNodeCliArgv(this.entry, args.slice(1)), {
      cwd: this.launchDirectory, shell: false, windowsHide: true,
      stdio: ['pipe','pipe','pipe'], env: childEnvironment
    });
    this.#child = child;
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 24 * 1024 * 1024) {
        if (!displayLimited) { displayLimited = true; report('CLI output exceeded the 24 MB display limit. Control events remain available; completion will remain unverified.'); }
      }
      decoder.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (stderrBytes >= 32768) return;
      const remaining = 32768 - stderrBytes;
      const part = chunk.subarray(0,remaining); stderrBytes += part.length; stderr += part.toString('utf8');
    });
    child.on('error', error => report(`Could not run the selected Babel CLI: ${error.message}`));
    child.on('close', (code, signal) => {
      decoder.end();
      this.#child = null;
      this.#approval=null;this.#runId=null;this.#approvalClosed=true;
      // Legacy controllers may ignore cooperative cancellation. Report the owned
      // process's observed closure after Stop, without replacing a CLI terminal.
      if(child.desktopCancelling&&!terminalReceived)send({kind:'event',event:{type:'cancelled',source:'desktop',reason:'owned_cli_closed_after_cancel'}});
      // stderr may contain provider diagnostics. Never forward raw stderr, environment,
      // keys, or credentials into the renderer. The CLI's structured error is preferred.
      send({kind:'exit', code, signal, diagnosticAvailable:stderr.length > 0, displayLimited});
      stderr = '';
    });
  }
  reply(request) {
    if (this.#approvalClosed || !this.#child?.stdin || this.#child.stdin.destroyed || request?.runId!==this.#runId) return false;
    const reply=scopedApprovalReply(request,this.#approval);
    if(!reply)return false;
    this.#approval=null;
    try{this.#child.stdin.write(`${JSON.stringify(reply)}\n`);return true;}catch{return false;}
  }
  whenIdle(callback) {
    if (typeof callback !== 'function') return;
    if (!this.#child) { callback(); return; }
    this.#child.once('close', callback);
  }
  cancel() {
    this.#approval=null;
    this.#approvalClosed=true;
    const child = this.#child;
    if (!child || child.desktopCancelling) return;
    child.desktopCancelling = true;
    let wrote = false;
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ decision: 'cancel' })}\n`);
        wrote = true;
      }
    } catch { /* The tree kill below is the backstop. */ }
    if (!wrote) {
      terminateChildTree(child);
      return;
    }
    const timer = setTimeout(() => {
      if (this.#child === child) terminateChildTree(child);
    }, 1500);
    child.once('close', () => clearTimeout(timer));
  }
}

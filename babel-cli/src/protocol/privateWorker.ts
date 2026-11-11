/**
 * A private, inherited-pipe protocol host. The parent owns the pipes and must
 * verify the launched runtime before sending credentials. This module does not
 * expose a listener and its handshake is not proof of executable identity.
 *
 * The existing executor still reads process-global environment variables. One
 * worker therefore serves exactly one frozen project/policy/provider boundary;
 * mismatched or legacy threads are refused rather than silently rebound.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

import type { SessionDescriptor } from '../executor/contracts.js';
import { ChatEngine } from '../agent/chatEngine.js';
import { hasUnsettledBackgroundShells } from '../agent/backgroundShell.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { acquireSessionPolicyLease, type SessionPolicyLease } from '../config/sessionPolicyLease.js';
import { constrainNewSessionPolicy, recordNewSessionPolicy } from '../config/sessionExecutionPolicy.js';
import { withExecutionPolicyChoice } from '../config/executionPolicySelection.js';
import { INSTRUCTION_MANIFEST_FILENAME, TASK_CONTRACT_FILENAME, TASK_MODE_HISTORY_FILENAME,
  loadLiveSessionAuthorityStrict, recoverCheckpointArtifacts } from '../agent/liveSessionBridge.js';
import { getThreadDir } from '../services/threadStore/threadStore.js';
import { loadSessionDescriptor } from '../services/threadStore/sessionDescriptor.js';
import { loadTurnTerminalRecord } from '../services/threadStore/index.js';
import { closeProtocolHostState, createProtocolHostState, handleProtocolRequest, type ProtocolHostState } from './client/host.js';
import type { BabelProtocolRequest, BabelProtocolServerNotification } from './messages.js';

const MAX_INPUT_FRAME = 1024 * 1024;
const MAX_OUTPUT_FRAME = 256 * 1024;
const MAX_OUTPUT_BUFFER = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_THREADS = 16;
const MAX_COMMANDS = 10_000;
const THREAD_ID = /^chat-[a-zA-Z0-9_-]{1,120}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const PROVIDER_KEYS: Readonly<Record<string, string | null>> = Object.freeze({
  ollama: null,
  openrouter: 'OPENROUTER_API_KEY',
  deepinfra: 'DEEPINFRA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'command-code': 'COMMAND_CODE_API_KEY',
  'opencode-go': 'BABEL_OPENCODE_GO_API_KEY',
});
const CREDENTIAL_NAMES = [...Object.values(PROVIDER_KEYS).filter((x): x is string => x !== null),
  'BABEL_COMPACTION_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENCODE_API_KEY', 'BABEL_COMPATIBLE_API_KEY', 'DEEPINFRA_TOKEN'];
const POLICY_ENV = [
  'BABEL_EXECUTION_PROFILE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_DOCKER_DISABLE',
  'BABEL_BENCHMARK_DOCKER_IMAGE', 'BABEL_ALLOWED_TOOLS', 'BABEL_ALLOWED_ROOTS',
  'BABEL_OPENCLAW_APPROVED_ROOTS', 'BABEL_PROJECT_CREDENTIALS_DIR', 'BABEL_ENV',
  'BABEL_PROVIDER', 'BABEL_MODEL', 'BABEL_DESKTOP_PROVIDER',
  'BABEL_REMOTE_OPERATOR_APPROVAL', 'BABEL_BENCHMARK_AUTO_APPROVE', 'BABEL_BENCHMARK_MODE',
  'BABEL_APPROVAL_SESSION', 'BABEL_READ_ONLY', 'BABEL_DRY_RUN', 'BABEL_TOOL_PROFILE',
  'BABEL_LIVE', 'BABEL_SHADOW_ROOT', 'BABEL_DESKTOP_IPC', 'BABEL_DESKTOP_CREDENTIALS_RESOLVED',
  'BABEL_DESKTOP_MODEL_ROUTE', 'BABEL_MODEL_POLICY_PATH', 'BABEL_OFFLINE', 'BABEL_LITE_OFFLINE',
  'BABEL_COMPACTION_MODEL', 'BABEL_DIFF_CRITIC_MODEL', 'BABEL_DIFF_CRITIC_PRO_MODEL',
  'BABEL_COMPACTION_API_BASE', 'BABEL_OLLAMA_BASE_URL',
] as const;

const idSchema = z.union([z.string().min(1).max(128), z.number().int().safe()]);
const threadId = z.string().regex(THREAD_ID);
const shortString = z.string().min(1).max(256);
const authoritySchema = z.object({
  project_root: z.string().min(1).max(4096),
  mode: z.enum(['chat', 'plan', 'deep']),
  execution_profile: z.enum(['host_native', 'safe_repo', 'dev_local']),
  approval_policy: z.literal('allow_once'),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(256),
  provider_model_id: z.string().min(1).max(256),
  credential_ref: z.string().min(1).max(256),
  configuration_generation: z.string().min(1).max(256),
  engine_generation: z.string().min(1).max(256),
}).strict();
type Authority = z.infer<typeof authoritySchema>;

const paramsByMethod: Record<string, z.ZodType> = {
  'worker.initialize': z.object({ protocol_version: z.literal(1), authority: authoritySchema }).strict(),
  'worker.credentials': z.object({ values: z.record(z.string(), z.string().min(1).max(16_384)) }).strict(),
  'worker.shutdown': z.object({}).strict(),
  'worker.thread_release': z.object({ thread_id: threadId }).strict(),
  'worker.turn_terminal': z.object({ thread_id: threadId, turn_id: z.number().int().positive().safe() }).strict(),
  'thread.create': z.object({ task: z.string().max(262_144).optional() }).strict(),
  'thread.resume': z.object({ thread_id: threadId }).strict(),
  'turn.submit': z.object({ thread_id: threadId, message: z.string().min(1).max(262_144),
    command_id: z.string().regex(SAFE_ID), repo_identity_confirmed: z.boolean().optional() }).strict(),
  'turn.cancel': z.object({ thread_id: threadId }).strict(),
  'history.lookup': z.object({ thread_id: threadId, cell_id: shortString.optional(),
    turn_id: z.number().int().positive().safe().optional(), limit: z.number().int().min(1).max(100).optional(),
    cursor: shortString.optional() }).strict(),
  'approval.lookup': z.object({ thread_id: threadId, turn_id: shortString.optional() }).strict(),
  'approval.decide': z.object({ thread_id: threadId, turn_id: shortString, approval_id: shortString,
    decision: z.enum(['allow_once', 'deny']), operation_digest: shortString.optional() }).strict(),
  'workspace.changes': z.object({ thread_id: threadId }).strict(),
  'verification.lookup': z.object({ thread_id: threadId }).strict(),
};

interface StoredAuthority { version: 1; digest: string }
type CommandRecord =
  | { kind: 'intent'; command_id: string; message_hash: string }
  | { kind: 'accepted'; command_id: string; turn_id: number }
  | { kind: 'rejected'; command_id: string };
interface OwnedThread { lease: SessionPolicyLease; commands: Map<string, { hash: string; turnId?: number; rejected?: true }> }

export interface PrivateWorkerOptions {
  input: Readable;
  output: Writable;
  /** Injection for tests; production creates the regular protocol host. */
  host?: ProtocolHostState;
  /** Test seam applied to a real engine before the host receives it. */
  onEngineCreated?: (descriptor: SessionDescriptor, engine: ChatEngine) => void;
}
export interface PrivateWorker {
  closed: Promise<{ settled: boolean }>;
  close(): Promise<{ settled: boolean }>;
}

function canonicalRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error('Project root must be absolute');
  const path = realpathSync(value);
  if (!statSync(path).isDirectory()) throw new Error('Project root must be a directory');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function stableDigest(authority: Authority): string {
  const { engine_generation: _engine, ...sessionAuthority } = authority;
  return createHash('sha256').update(JSON.stringify(sessionAuthority)).digest('hex');
}

function authorityPath(thread: string): string { return join(getThreadDir(thread), 'private-worker-authority.json'); }
function commandsPath(thread: string): string { return join(getThreadDir(thread), 'private-worker-commands.jsonl'); }
function hashMessage(message: string): string { return createHash('sha256').update(message).digest('hex'); }

function appendCommand(thread: string, record: CommandRecord): void {
  const fd = openSync(commandsPath(thread), 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function readCommands(thread: string): OwnedThread['commands'] {
  const commands: OwnedThread['commands'] = new Map();
  const path = commandsPath(thread);
  if (!existsSync(path)) return commands;
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error('Command journal exceeds its safety limit');
  const raw = readFileSync(path, 'utf8');
  if (raw && !raw.endsWith('\n')) throw new Error('Incomplete command journal');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row: CommandRecord;
    try { row = JSON.parse(line) as CommandRecord; } catch { throw new Error('Invalid command journal'); }
    if (!row || typeof row.command_id !== 'string' || !SAFE_ID.test(row.command_id)) throw new Error('Invalid command journal');
    const previous = commands.get(row.command_id);
    if (row.kind === 'intent' && !previous && typeof row.message_hash === 'string' && /^[0-9a-f]{64}$/.test(row.message_hash)) {
      commands.set(row.command_id, { hash: row.message_hash });
    } else if (row.kind === 'accepted' && previous && previous.turnId === undefined && !previous.rejected
      && Number.isSafeInteger(row.turn_id) && row.turn_id > 0) {
      previous.turnId = row.turn_id;
    } else if (row.kind === 'rejected' && previous && previous.turnId === undefined && !previous.rejected) {
      previous.rejected = true;
    } else { throw new Error('Invalid command journal'); }
    if (commands.size > MAX_COMMANDS) throw new Error('Command journal exceeds its safety limit');
  }
  return commands;
}

function matchesDescriptor(descriptor: SessionDescriptor | null, authority: Authority): boolean {
  if (!descriptor || descriptor.schemaVersion !== 1 || descriptor.harness_adapter_id) return false;
  try {
    return canonicalRoot(descriptor.projectRoot) === authority.project_root
      && descriptor.mode === authority.mode && descriptor.policyProfile === authority.execution_profile
      && descriptor.provider === authority.provider && descriptor.model === authority.model;
  } catch { return false; }
}

/** Returns only a bounded display preview; durable evidence is kept separately. */
function previewText(value: string, bytes = MAX_PREVIEW_BYTES): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= bytes) return { text: value, truncated: false };
  let text = buffer.subarray(0, bytes).toString('utf8');
  // Avoid leaving a partial code point at the cut.
  if (text.endsWith('\uFFFD')) text = text.slice(0, -1);
  return { text, truncated: true };
}

export function startPrivateWorker({ input, output, host: injectedHost, onEngineCreated }: PrivateWorkerOptions): PrivateWorker {
  let authority: Authority | undefined;
  let authorityDigest = '';
  let host: ProtocolHostState | undefined;
  let credentialsReady = false;
  let closing: Promise<{ settled: boolean }> | undefined;
  let closedResolve!: (value: { settled: boolean }) => void;
  const closed = new Promise<{ settled: boolean }>((resolve) => { closedResolve = resolve; });
  const owned = new Map<string, OwnedThread>();
  const seenThreads = new Set<string>();
  const policyEnvironment = new Map<string, string | undefined>();
  const secrets: string[] = [];
  const previewBytes = new Map<string, number>();
  const previewOmitted = new Set<string>();
  let sequence = 0;
  let shuttingDown = false;

  const redact = (_key: string, value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
    return result;
  };
  const write = (packet: Record<string, unknown>, control = true): boolean => {
    if (shuttingDown && !control) return false;
    let encoded: string;
    try { encoded = `${JSON.stringify({ ...packet, worker_seq: sequence }, redact)}\n`; }
    catch { void close(); return false; }
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_OUTPUT_FRAME || output.destroyed || output.writableLength + bytes > MAX_OUTPUT_BUFFER) {
      void close();
      return false;
    }
    sequence += 1;
    try { output.write(encoded); return true; } catch { void close(); return false; }
  };
  const respond = (id: string | number | null, result: unknown): void => {
    const packet = { jsonrpc: '2.0', id, result };
    const preview = JSON.stringify(packet, redact);
    if (Buffer.byteLength(preview) > MAX_OUTPUT_FRAME - 1024) {
      write({ jsonrpc: '2.0', id, error: { code: -32020, message: 'Response exceeds the preview limit; query a smaller page or the turn terminal.' } });
      return;
    }
    write(packet);
  };
  const fail = (id: string | number | null, code: number, message: string): void => {
    write({ jsonrpc: '2.0', id, error: { code, message } });
  };
  const environmentUnchanged = (): boolean => {
    if (![...policyEnvironment].every(([name, value]) => process.env[name] === value)) return false;
    try {
      return !process.env['BABEL_PROJECT_ROOT'] || Boolean(authority
        && canonicalRoot(process.env['BABEL_PROJECT_ROOT']) === authority.project_root);
    } catch { return false; }
  };
  const guardRoot = (root: string): string => {
    if (!authority || canonicalRoot(root) !== authority.project_root) throw new Error('Project authority mismatch');
    return authority.project_root;
  };
  const release = (thread: string): void => {
    const owner = owned.get(thread);
    if (!owner) return;
    const engine = host?.engines.get(thread);
    if (engine && !engine.hasKnownPhysicalSettlement()) throw new Error('Physical settlement is unknown; inspect the session before releasing ownership');
    // Retire the engine's admission and mutation authority while the exclusive
    // worker lease is still held; a successor must not overlap stale authority.
    engine?.closeAdmissionStore();
    host?.admissionStores.get(thread)?.close();
    host?.admissionStores.delete(thread);
    let leaseError: unknown;
    try { owner.lease.release(); }
    catch (error) { leaseError = error; }
    finally {
      // Host state must not outlive the ownership record even when the lease
      // release fails; otherwise close() can never reach this engine.
      owned.delete(thread);
      host?.engines.delete(thread);
      host?.descriptors.delete(thread);
      host?.restoreReports.delete(thread);
      host?.launchCounters.delete(thread);
      host?.verificationByThread.delete(thread);
      for (const key of host?.idempotency.keys() ?? []) if (key.startsWith(`${thread}:`)) host?.idempotency.delete(key);
      for (const key of host?.lastMessageIntegrity.keys() ?? []) if (key.startsWith(`${thread}:`)) host?.lastMessageIntegrity.delete(key);
      for (const key of host?.turnTerminals.keys() ?? []) if (key.startsWith(`${thread}:`)) host?.turnTerminals.delete(key);
    }
    if (leaseError) throw leaseError;
  };
  const ownThread = (thread: string): OwnedThread => {
    const prior = owned.get(thread);
    if (!authority) throw new Error('Worker is not initialized');
    if (!matchesDescriptor(loadSessionDescriptor(thread), authority)) throw new Error('Thread authority mismatch');
    let saved: StoredAuthority;
    try { saved = JSON.parse(readFileSync(authorityPath(thread), 'utf8')) as StoredAuthority; }
    catch { throw new Error('Thread authority is unavailable'); }
    if (saved.version !== 1 || saved.digest !== authorityDigest) throw new Error('Thread authority mismatch');
    if (prior) return prior;
    if (owned.size >= MAX_THREADS || (!seenThreads.has(thread) && seenThreads.size >= 64)) {
      throw new Error('Worker thread limit reached; restart required');
    }
    const lease = acquireSessionPolicyLease(thread, {create:true});
    try {
      const result = { lease, commands: readCommands(thread) };
      owned.set(thread, result);
      seenThreads.add(thread);
      return result;
    } catch {
      lease.release();
      throw new Error('Thread is already owned or cannot be safely restored');
    }
  };

  const notify = (notification: BabelProtocolServerNotification): void => {
    if (shuttingDown) return;
    if (notification.method === 'turn.event') {
      const { thread_id: thread, turn_id: turn, event } = notification.params;
      const key = `${thread}:${turn}`;
      const terminal = event.type === 'done' || event.type === 'failed' || event.type === 'cancelled';
      const eventCopy: Record<string, unknown> = { ...event };
      let truncated = false;
      for (const field of ['text', 'detail', 'answer', 'error', 'content']) {
        if (typeof eventCopy[field] === 'string') {
          const allowed = terminal ? MAX_PREVIEW_BYTES : Math.max(0, MAX_PREVIEW_BYTES - (previewBytes.get(key) ?? 0));
          const preview = previewText(eventCopy[field] as string, allowed);
          eventCopy[field] = preview.text;
          truncated ||= preview.truncated;
          if (!terminal) previewBytes.set(key, (previewBytes.get(key) ?? 0) + Buffer.byteLength(preview.text));
        }
      }
      if (!terminal && truncated && !previewOmitted.has(key)) {
        previewOmitted.add(key);
        write({ jsonrpc: '2.0', method: 'worker.preview_truncated', params: { thread_id: thread, turn_id: turn } });
      }
      if (!terminal && truncated && event.type === 'answer_chunk' && eventCopy['text'] === '') return;
      if (terminal) {
        const recorded = host?.turnTerminals.get(key);
        if (!recorded || recorded.durable_persist_failed) {
          write({ jsonrpc: '2.0', method: 'worker.durability', params: { thread_id: thread, turn_id: turn, status: 'unverified' } });
        }
        previewBytes.delete(key);
        previewOmitted.delete(key);
      }
      write({ ...notification, params: { ...notification.params, event: eventCopy, ...(truncated ? { preview_truncated: true } : {}) } }, terminal);
      return;
    }
    // Cell bodies can be very large. Their authoritative copies are queried by
    // thread/turn; a short notification still reports the commit and omission.
    if (notification.method === 'cell.committed') {
      const body = JSON.stringify(notification, redact);
      if (Buffer.byteLength(body) > MAX_OUTPUT_FRAME - 1024) {
        write({ ...notification, params: { ...notification.params, cells: [], preview_truncated: true } });
        return;
      }
    }
    write(notification as unknown as Record<string, unknown>);
  };

  async function close(): Promise<{ settled: boolean }> {
    if (closing) return closing;
    shuttingDown = true;
    input.destroy();
    closing = (async () => {
      if (host) {
        for (const [thread, launch] of host.activeTurns) {
          host.engines.get(thread)?.cancel();
          host.approvalBroker.cancelTurn(thread, String(launch.turnId));
        }
        const deadline = Date.now() + 8000;
        while ((host.activeTurns.size || [...owned.keys()].some((thread) => hasUnsettledBackgroundShells(thread)))
          && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let settled = !host || (host.activeTurns.size === 0
        && ![...owned.keys()].some((thread) => hasUnsettledBackgroundShells(thread)));
      if (settled) {
        try {
          for (const thread of [...owned.keys()]) release(thread);
          if (host) closeProtocolHostState(host);
        } catch { settled = false; }
      }
      for (const name of CREDENTIAL_NAMES) delete process.env[name];
      secrets.length = 0;
      if (!output.destroyed) output.end(() => output.destroy());
      closedResolve({ settled });
      return { settled };
    })();
    return closing;
  }

  async function dispatch(raw: unknown): Promise<void> {
    const envelope = z.object({ jsonrpc: z.literal('2.0'), id: idSchema, method: z.string().max(128), params: z.unknown() }).strict().safeParse(raw);
    if (!envelope.success) { fail(null, -32600, 'Invalid request envelope'); return; }
    const { id, method } = envelope.data;
    const schema = Object.hasOwn(paramsByMethod, method) ? paramsByMethod[method] : undefined;
    if (!schema) { fail(id, -32601, 'Unknown method'); return; }
    const result = schema.safeParse(envelope.data.params);
    if (!result.success) { fail(id, -32602, 'Invalid parameters'); return; }
    const params = result.data as Record<string, any>;
    if (method === 'worker.initialize') {
      if (authority) { fail(id, -32600, 'Worker is already initialized'); return; }
      const candidate = params.authority as Authority;
      try {
        if (candidate.mode !== 'chat') throw new Error('Mode is not qualified for this worker');
        if (!Object.hasOwn(PROVIDER_KEYS, candidate.provider)) throw new Error('Provider is not qualified for this worker');
        candidate.project_root = canonicalRoot(candidate.project_root);
        if (process.env['BABEL_EXECUTION_PROFILE'] !== candidate.execution_profile) throw new Error('Execution boundary mismatch');
        if (['1', 'true', 'yes'].includes((process.env['BABEL_ALLOW_HOST_FALLBACK'] ?? '').toLowerCase())) throw new Error('Host fallback is not permitted');
        if (candidate.execution_profile === 'safe_repo' && process.env['BABEL_DOCKER_DISABLE'] === 'true') throw new Error('Docker boundary is disabled');
        if (process.env['BABEL_PROJECT_CREDENTIALS_DIR']) throw new Error('Project credential loading must be scoped by the parent');
        if (process.env['BABEL_REMOTE_OPERATOR_APPROVAL'] !== '1') throw new Error('Operation-bound approval is not enabled');
        if (process.env['BABEL_BENCHMARK_AUTO_APPROVE'] === '1' || process.env['BABEL_BENCHMARK_MODE'] === '1') throw new Error('Benchmark approval settings are not permitted');
        if (CREDENTIAL_NAMES.some((name) => process.env[name])) throw new Error('Worker must start without provider credentials');
        if (process.env['BABEL_PROVIDER'] && process.env['BABEL_PROVIDER'] !== candidate.provider) throw new Error('Provider boundary mismatch');
        if (process.env['BABEL_MODEL'] && process.env['BABEL_MODEL'] !== candidate.model) throw new Error('Model boundary mismatch');
        if (process.env['BABEL_DESKTOP_PROVIDER'] !== candidate.provider) throw new Error('Desktop provider boundary mismatch');
        if (process.env['BABEL_DESKTOP_MODEL_ROUTE'] && process.env['BABEL_DESKTOP_MODEL_ROUTE'] !== candidate.model) throw new Error('Desktop model boundary mismatch');
        if (process.env['BABEL_PROJECT_ROOT'] && canonicalRoot(process.env['BABEL_PROJECT_ROOT']) !== candidate.project_root) throw new Error('Project boundary mismatch');
        const compactionBase = process.env['BABEL_COMPACTION_API_BASE'];
        const compactionEndpoints: Record<string, string> = {
          openrouter: 'https://openrouter.ai/api/v1/chat/completions',
          deepinfra: 'https://api.deepinfra.com/v1/openai/chat/completions',
          deepseek: 'https://api.deepseek.com/v1/chat/completions',
        };
        if (compactionBase && compactionEndpoints[candidate.provider] !== compactionBase) throw new Error('Compaction endpoint boundary mismatch');
        authority = Object.freeze(candidate);
        authorityDigest = stableDigest(candidate);
        for (const name of [...POLICY_ENV, ...CREDENTIAL_NAMES]) policyEnvironment.set(name, process.env[name]);
        host = injectedHost ?? createProtocolHostState({ remoteSurface: true, projectRootGuard: guardRoot });
        if (!host.remoteSurface) throw new Error('Operation-bound approval surface is required');
        host.projectRootGuard = guardRoot;
        // A fresh engine followed by assignRunId persists fresh authority into
        // an existing session before hydration. Construct with the final run
        // ID and recover retained authority first, as the canonical resume
        // path does; never substitute a new objective for retained history.
        const buildEngine = injectedHost?.engineFactory ?? ((descriptor: SessionDescriptor): ChatEngine => {
          const sessionDir = chatSessionDir(descriptor.threadId);
          recoverCheckpointArtifacts(sessionDir);
          const hasRetainedAuthority = [INSTRUCTION_MANIFEST_FILENAME, TASK_CONTRACT_FILENAME, TASK_MODE_HISTORY_FILENAME]
            .some((name) => existsSync(join(sessionDir, name)));
          const restore = host?.restoreReports.get(descriptor.threadId);
          if (!hasRetainedAuthority && restore?.source && restore.source !== 'none') {
            throw new Error('Retained session authority is unavailable');
          }
          if (hasRetainedAuthority) {
            const retained = loadLiveSessionAuthorityStrict(sessionDir);
            if (retained.taskContract.mode !== descriptor.mode) throw new Error('Retained session mode does not match');
          }
          const executionPolicy=constrainNewSessionPolicy({profile:candidate.execution_profile,source:'explicit'});
          const engine=withExecutionPolicyChoice(executionPolicy,()=>new ChatEngine({
            task: descriptor.task ?? `Session ${descriptor.threadId}`,
            projectRoot: descriptor.projectRoot,
            runtimeMode: 'direct',
            provider: descriptor.provider,
            model: descriptor.model,
            executionProfile: descriptor.mode,
            executionPolicy,
            runId: descriptor.threadId,
            ...(hasRetainedAuthority ? { resumeExisting: true } : {}),
          }));
          // A new worker-created session must publish the same durable policy a
          // CLI-created session does, so a later resume preserves its boundary.
          if (!hasRetainedAuthority) recordNewSessionPolicy(engine);
          return engine;
        });
        host.engineFactory = (descriptor) => {
          const engine = buildEngine(descriptor);
          onEngineCreated?.(descriptor, engine);
          const selection = engine.getProviderSelectionStatus();
          // Explicit connection endpoints have a separate credential/endpoint
          // trust boundary which this worker has not qualified yet.
          if (selection.connection !== null || selection.provider !== candidate.provider
            || selection.requestedModel !== candidate.provider_model_id) {
            throw new Error('Effective engine provider or model does not match the worker authority');
          }
          return engine;
        };
        if (!injectedHost) {
          // The private transport supplies ownership and approvals, but Chat
          // must use the same turn preparation and controller as the TUI.
          host.runCanonicalChatTurn = async ({engine,descriptor,task,turnId,isCancelled,emit}) => {
            const {runChatEngineOnce} = await import('../interactive/execution/chatCore.js');
            let terminal: import('../agent/chatEngine.js').ChatEvent | undefined;
            let terminalCount = 0;
            const result = await runChatEngineOnce({
              task,
              target:{targetRoot:descriptor.projectRoot,workspaceRoot:null,project:null,source:'explicit_project_root',cwd:descriptor.projectRoot},
              engine,model:descriptor.model,executionProfile:'chat',runtimeMode:'direct',useStreaming:true,
              externalProtocolTurn:{threadId:descriptor.threadId,turnId,isCancelled},
              onChatEvent:event=>{
                if (event.type==='done'||event.type==='failed'||event.type==='cancelled') { terminal=event;terminalCount++; }
                else emit(event);
              },
            });
            if (terminalCount !== 1 || !terminal) {
              emit({type:'failed',error:'The chat controller ended without one authoritative terminal event.'});
            } else if (result.status === 'cancelled' && terminal.type !== 'cancelled') {
              emit({type:'failed',error:'The chat controller returned conflicting terminal outcomes.'});
            } else emit(terminal);
          };
        }
        respond(id, { protocol_version: 1, engine_generation: candidate.engine_generation, mode: 'chat' });
      } catch (error) {
        authority = undefined;
        if (host && !injectedHost) {
          try { closeProtocolHostState(host); } catch { /* fail closed */ }
          host = undefined;
        }
        fail(id, -32602, error instanceof Error ? error.message : 'Invalid worker authority');
      }
      return;
    }
    if (!authority || !host) { fail(id, -32600, 'Initialize the worker first'); return; }
    if (method === 'worker.shutdown') { respond(id, { shutting_down: true }); void close(); return; }
    if (!environmentUnchanged()) { fail(id, -32021, 'Worker authority changed; restart required'); return; }
    if (method === 'worker.credentials') {
      if (credentialsReady) { fail(id, -32600, 'Credential binding is immutable'); return; }
      const values = params.values as Record<string, string>;
      const expected = PROVIDER_KEYS[authority.provider];
      const names = Object.keys(values);
      if (expected === undefined || (expected === null ? names.length !== 0 : names.length !== 1 || names[0] !== expected)) {
        fail(id, -32602, 'Credentials do not match the worker provider'); return;
      }
      if (expected) { const value = values[expected]!; process.env[expected] = value; secrets.push(value); policyEnvironment.set(expected, value); }
      credentialsReady = true;
      respond(id, { bound: true });
      return;
    }
    if (!credentialsReady) { fail(id, -32600, 'Bind the worker credentials first'); return; }
    try {
      if (method === 'thread.create') {
        if (owned.size >= MAX_THREADS || seenThreads.size >= 64) throw new Error('Worker thread limit reached; restart required');
        const response = await handleProtocolRequest({ jsonrpc: '2.0', id, method: 'thread.create', params: {
          project_root: authority.project_root, mode: authority.mode, policy_profile: authority.execution_profile,
          provider: authority.provider, model: authority.model, ...(params.task !== undefined ? { task: params.task } : {}),
        } }, host, notify);
        if ('error' in response) { write({ ...response, id }); return; }
        const thread = (response.result as { thread_id: string }).thread_id;
        writeFileSync(authorityPath(thread), `${JSON.stringify({ version: 1, digest: authorityDigest })}\n`, { flag: 'wx', mode: 0o600 });
        ownThread(thread);
        respond(id, response.result);
        return;
      }
      const thread = params.thread_id as string;
      const owner = ownThread(thread);
      if (method === 'worker.thread_release') {
        if (host.activeTurns.has(thread) || hasUnsettledBackgroundShells(thread)) throw new Error('Thread is still running or settling');
        release(thread); respond(id, { released: true }); return;
      }
      if (method === 'worker.turn_terminal') {
        const record = loadTurnTerminalRecord(thread, params.turn_id as number);
        if (!record) { respond(id, { status: 'unknown' }); return; }
        const answer = typeof record.answer === 'string' ? previewText(record.answer) : undefined;
        const error = typeof record.error === 'string' ? previewText(record.error) : undefined;
        respond(id, { status: 'durable', terminal: { ...record,
          ...(answer ? { answer: answer.text } : {}), ...(error ? { error: error.text } : {}),
          ...((answer?.truncated || error?.truncated) ? { preview_truncated: true } : {}) } });
        return;
      }
      if (method === 'turn.submit') {
        const command = params.command_id as string;
        const hash = hashMessage(params.message as string);
        const previous = owner.commands.get(command);
        if (previous) {
          if (previous.hash !== hash) throw new Error('Command id was already used for another message');
          if (previous.turnId !== undefined) { respond(id, { thread_id: thread, turn_id: previous.turnId, replayed: true }); return; }
          if (previous.rejected) throw new Error('This command id was already rejected; use a new command id to retry');
          throw new Error('Previous submission outcome is unresolved; inspect durable evidence before retrying');
        }
        if (host.activeTurns.size) throw new Error('A worker turn is already active');
        if (owner.commands.size >= MAX_COMMANDS) throw new Error('Command journal exceeds its safety limit');
        appendCommand(thread, { kind: 'intent', command_id: command, message_hash: hash });
        owner.commands.set(command, { hash });
        const response = await handleProtocolRequest({ jsonrpc: '2.0', id, method: 'turn.submit', params: {
          thread_id: thread, message: params.message as string, command_id: command,
          ...(params.repo_identity_confirmed === true ? { repo_identity_confirmed: true } : {}),
        } }, host, notify);
        if ('error' in response) {
          appendCommand(thread, { kind: 'rejected', command_id: command });
          owner.commands.get(command)!.rejected = true;
          write({ ...response, id });
        } else {
          const turn = (response.result as { turn_id: number }).turn_id;
          appendCommand(thread, { kind: 'accepted', command_id: command, turn_id: turn });
          owner.commands.get(command)!.turnId = turn;
          respond(id, response.result);
        }
        return;
      }
      const request = { jsonrpc: '2.0', id, method, params } as BabelProtocolRequest;
      const response = await handleProtocolRequest(request, host, notify);
      if ('error' in response) write({ ...response, id }); else respond(id, response.result);
    } catch (error) {
      fail(id, -32022, error instanceof Error ? error.message : 'Worker operation failed');
    }
  }

  void (async () => {
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of input) {
        if (shuttingDown) break;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        while (start < bytes.length) {
          const end = bytes.indexOf(10, start);
          const segment = bytes.subarray(start, end === -1 ? bytes.length : end);
          if (pending.length + segment.length > MAX_INPUT_FRAME) throw new Error('Input frame exceeds limit');
          pending = pending.length ? Buffer.concat([pending, segment]) : segment;
          if (end === -1) break;
          const line = pending;
          pending = Buffer.alloc(0);
          start = end + 1;
          let parsed: unknown;
          try { parsed = JSON.parse(line.toString('utf8')); } catch { fail(null, -32700, 'Invalid JSON'); continue; }
          await dispatch(parsed);
          if (shuttingDown) break;
        }
      }
    } catch { /* A broken or oversized pipe closes the worker; outcomes require reconciliation. */ }
    finally { await close(); }
  })();
  output.on('error', () => { void close(); });
  return { closed, close };
}

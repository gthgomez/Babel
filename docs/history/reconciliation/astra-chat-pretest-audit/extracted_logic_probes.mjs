/**
 * Babel pre-experiment source-logic probes, 2026-09-14.
 * Audited source: gthgomez/Babel @ 18fd3f50b33525f41bba5e5ce0d233097b5b7413.
 *
 * IMPORTANT: This is NOT an imported Babel test suite. Repository cloning was
 * unavailable. Functions labelled `transcribed` were manually transcribed from
 * fetched TypeScript with type annotations removed. Reduced models test the
 * stated local control-flow argument, NOT the integrated engine or transport.
 * Successful assertions below reproduce a defect or check a mitigation; they
 * are NOT readiness passes. No network or inference is used.
 * Run: node extracted_logic_probes.mjs
 *      -> prints the JSON report to stdout and writes no file.
 *      node extracted_logic_probes.mjs --out probe_results.json
 *      -> additionally rewrites the evidence file at the given path.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

// Transcribed: src/agent/threadEventLog.ts, rebuildProviderMessagesFromEvents.
function rebuildProviderMessagesFromEvents(log, options = {}) {
  const events = options.upToSeq === undefined
    ? log.events : log.events.filter(e => e.seq <= options.upToSeq);
  let startIdx = 0;
  let capsuleContent = null;
  for (let i = 0; i < events.length; i++) {
    if (events[i].kind === 'compaction_capsule') {
      startIdx = i + 1;
      capsuleContent = events[i].content;
    }
  }
  const messages = [];
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
  if (capsuleContent) messages.push({ role: 'system', content: capsuleContent, name: 'compaction_capsule' });
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i];
    switch (e.kind) {
      case 'user_message': messages.push({ role: 'user', content: e.content }); break;
      case 'assistant_message': messages.push({ role: 'assistant', content: e.content }); break;
      case 'assistant_tool_calls': {
        const msg = { role: 'assistant', content: e.content || 'Using tools…', name: 'tool_calls' };
        if (e.tool_calls.length > 0) msg.tool_calls = e.tool_calls;
        messages.push(msg);
        break;
      }
      case 'tool_result': messages.push({ role: 'tool', content: e.content, tool_call_id: e.tool_call_id, name: e.tool_name }); break;
      default: break;
    }
  }
  return messages;
}

// Transcribed: src/runners/providerMessages.ts, validator and helper.
function looksLikeSystemInUserProse(content) {
  return /^##\s*Conversation History/m.test(content)
    || /^###\s*(system|assistant|user|tool)\b/m.test(content)
    || (content.includes('## Current Request') && content.includes('## Conversation History'));
}
function validateProviderMessageProtocol(messages) {
  const issues = [];
  if (messages.length === 0) {
    issues.push({ code: 'empty_messages', message: 'Provider message array is empty' });
    return issues;
  }
  const knownCallIds = new Set();
  const answeredCallIds = new Set(); // Unused in inspected source as well.
  const seenResultIds = new Set();
  let pendingCallIds = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && looksLikeSystemInUserProse(msg.content)) {
      issues.push({ code: 'system_in_user_content', message: 'User message appears to embed system/history Markdown (flattened protocol)', index: i });
    }
    if (pendingCallIds && msg.role !== 'tool') {
      for (const id of pendingCallIds) issues.push({ code: 'unanswered_tool_call', message: `Assistant tool_call id=${id} has no tool result before the next non-tool message`, index: i });
      pendingCallIds = null;
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      const declared = [];
      for (const tc of msg.tool_calls) {
        if (!tc.id) issues.push({ code: 'assistant_tool_call_missing_id', message: 'Assistant tool_call missing id', index: i });
        else { knownCallIds.add(tc.id); declared.push(tc.id); }
      }
      pendingCallIds = new Set(declared);
    }
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) {
        issues.push({ code: 'tool_missing_call_id', message: 'Tool message missing tool_call_id', index: i });
        continue;
      }
      if (!knownCallIds.has(msg.tool_call_id)) issues.push({ code: 'orphan_tool_result', message: `Tool result tool_call_id=${msg.tool_call_id} has no preceding assistant tool_call`, index: i });
      if (seenResultIds.has(msg.tool_call_id)) issues.push({ code: 'duplicate_tool_result', message: `Tool result tool_call_id=${msg.tool_call_id} appears more than once`, index: i });
      seenResultIds.add(msg.tool_call_id);
      pendingCallIds?.delete(msg.tool_call_id);
    }
  }
  if (pendingCallIds) {
    for (const id of pendingCallIds) issues.push({ code: 'unanswered_tool_call', message: `Assistant tool_call id=${id} has no tool result before the end of the payload`, index: messages.length - 1 });
  }
  return issues;
}

// Transcribed resolver body, with env supplied instead of process.env for isolation.
function resolveRuntimeInvariantMode(explicit, env = {}) {
  if (explicit) return explicit;
  const configured = env.BABEL_RUNTIME_INVARIANTS;
  if (configured === 'enforce' || configured === 'shadow' || configured === 'off') return configured;
  return env.NODE_ENV === 'production' && !env.CI ? 'shadow' : 'enforce';
}

// Transcribed: src/agent/chatEngineCriticBudget.ts.
function computeCriticRepairCostCap(input) {
  const fraction = input.fraction ?? 0.35;
  const minUsd = input.minUsd ?? 0.25;
  const maxUsd = input.maxUsd ?? 0.75;
  const remaining = Math.max(0, input.sessionMaxCostUsd - input.spentUsd);
  if (remaining <= 0) return { capUsd: input.sessionMaxCostUsd, repairWindowUsd: 0 };
  const raw = remaining * fraction;
  const repairWindowUsd = Math.min(maxUsd, Math.max(minUsd, raw));
  const window = Math.min(repairWindowUsd, remaining);
  return { capUsd: input.spentUsd + window, repairWindowUsd: window };
}
function computePostWriteRepairWallMs(input) {
  const remaining = Math.max(0, input.sessionMaxWallMs - input.elapsedMs);
  if (remaining <= 0) return { capMs: input.sessionMaxWallMs, repairWindowMs: 0 };
  const fraction = input.fraction ?? 0.4;
  const minMs = input.minMs ?? 90_000;
  const maxMs = input.maxMs ?? 180_000;
  if (remaining <= minMs) return { capMs: input.elapsedMs + remaining, repairWindowMs: remaining };
  const raw = remaining * fraction;
  const repairWindowMs = Math.min(remaining, Math.min(maxMs, Math.max(minMs, raw)));
  return { capMs: input.elapsedMs + repairWindowMs, repairWindowMs };
}
// Exact relevant expression from ChatEngine.checkBudgets (local expression probe).
function effectiveCostCeiling(sessionLimit, repairCap) {
  return Number.isFinite(sessionLimit) && repairCap !== null
    ? Math.min(sessionLimit, repairCap) : sessionLimit;
}

// Reduced model of inspected terminal parser behavior. Not Babel's SSE parser.
function modelStreamTail({ answerText = '', finishReason = null, pendingCalls = [] } = {}) {
  const toolUses = pendingCalls.map(call => {
    let input = {};
    try { input = JSON.parse(call.arguments); } catch { /* inspected fallback */ }
    return { type: 'tool_use', id: call.id, name: call.name, input };
  });
  const done = { type: 'done', finishReason: finishReason || 'stop' };
  // ChatEngine ignores the done payload and synthesizes a ChatTurn afterwards.
  const turn = toolUses.length ? { type: 'tool_calls', actions: toolUses }
    : { type: 'completion', answer: answerText || 'OK' };
  return { toolUses, done, turn };
}
// Reduced model of consumeChatStream's exception/absent-terminal cases.
async function modelConsumeTerminal(stream) {
  let terminal;
  try {
    for await (const event of stream) if (event.type === 'done') terminal = event;
  } catch (error) {
    return { status: 'failed', outcome: 'AGENT_FAILURE', answer: String(error.message ?? error) };
  }
  if (!terminal) return { status: 'cancelled', outcome: 'CANCELLED' };
  return { status: 'completed', outcome: terminal.outcome, answer: terminal.answer };
}

const results = [];
async function probe(id, fidelity, finding, fn) {
  try {
    const observation = await fn();
    results.push({ id, fidelity, assertion: 'satisfied', finding, observation });
  } catch (error) {
    results.push({ id, fidelity, assertion: 'FAILED', finding, error: error.stack });
  }
}
const call = (id, name = 'read_file') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const token = 'ONLY_KEPT_RESULT_HAS_THE_NONCE_4d713';
const initialLog = { events: [
  { seq: 0, kind: 'user_message', content: 'Use the exact nonce returned by the tool.' },
  { seq: 1, kind: 'assistant_tool_calls', content: '', tool_calls: [call('c1')] },
  { seq: 2, kind: 'tool_result', tool_call_id: 'c1', tool_name: 'read_file', content: token },
] };
await probe('P01', 'transcribed-function', 'positive control: uncompacted history retains the result', () => {
  const messages = rebuildProviderMessagesFromEvents(initialLog, { systemPrompt: 'System' });
  assert.equal(messages.some(m => m.content.includes(token)), true);
  assert.deepEqual(validateProviderMessageProtocol(messages), []);
  return { retained: true, protocolIssues: 0 };
});
await probe('P02', 'transcribed-function + explicit fixture', 'compaction drops the retained tail from native reconstruction', () => {
  const liveTail = rebuildProviderMessagesFromEvents(initialLog);
  const compactedLog = { events: [...initialLog.events,
    { seq: 3, kind: 'compaction_capsule', content: 'Task: use exact nonce. Recent tool: read_file.', preserved_tool_call_ids: ['c1'] }] };
  const outbound = rebuildProviderMessagesFromEvents(compactedLog, { systemPrompt: 'System' });
  assert.equal(liveTail.some(m => m.content.includes(token)), true);
  assert.equal(outbound.some(m => m.content.includes(token)), false);
  assert.equal(outbound.some(m => m.tool_call_id === 'c1'), false);
  assert.deepEqual(validateProviderMessageProtocol(outbound), []);
  return { liveTailRetainsNonce: true, nativeRetainsNonce: false, claimedPreservedIds: ['c1'], deliveredToolResultIds: [], protocolIssues: 0 };
});
await probe('P03', 'transcribed-function + explicit fixture', 'reloading the same durable log reproduces the loss', () => {
  const log = { events: [...initialLog.events, { seq: 3, kind: 'compaction_capsule', content: 'Summary without retained nonce.' }] };
  const restored = JSON.parse(JSON.stringify(log));
  assert.deepEqual(rebuildProviderMessagesFromEvents(log), rebuildProviderMessagesFromEvents(restored));
  assert.equal(rebuildProviderMessagesFromEvents(restored).some(m => m.content.includes(token)), false);
  return { restartRepairsMissingContext: false };
});
await probe('P04', 'transcribed-function + explicit fixture', 'a live-only working-state message cannot enter the durable projector', () => {
  const liveOnly = { role: 'system', name: 'working_state', content: 'ACTIVE_REQUIREMENT_NONCE' };
  const live = [...rebuildProviderMessagesFromEvents(initialLog), liveOnly];
  const native = rebuildProviderMessagesFromEvents(initialLog);
  assert.equal(live.some(m => m.content.includes('ACTIVE_REQUIREMENT_NONCE')), true);
  assert.equal(native.some(m => m.content.includes('ACTIVE_REQUIREMENT_NONCE')), false);
  return { liveOnlyMessageDelivered: false, note: 'Call-site reachability must be verified in integrated tests.' };
});
await probe('P05', 'transcribed-function', 'positive control: unanswered calls are detected', () => {
  const issues = validateProviderMessageProtocol([{ role: 'assistant', content: '', tool_calls: [call('a')] }]);
  assert.equal(issues.some(i => i.code === 'unanswered_tool_call'), true);
  return issues.map(i => i.code);
});
await probe('P06', 'transcribed-function', 'duplicate declared IDs collapse to one pending ID', () => {
  const issues = validateProviderMessageProtocol([
    { role: 'assistant', content: '', tool_calls: [call('same', 'read_file'), call('same', 'grep')] },
    { role: 'tool', content: 'one result only', tool_call_id: 'same' },
  ]);
  assert.deepEqual(issues, []);
  return { declaredCalls: 2, declaredUniqueIds: 1, results: 1, validatorIssues: [] };
});
await probe('P07', 'transcribed-function, env parameterized', 'production defaults to observation rather than prevention', () => {
  assert.equal(resolveRuntimeInvariantMode(undefined, { NODE_ENV: 'production' }), 'shadow');
  assert.equal(resolveRuntimeInvariantMode(undefined, { NODE_ENV: 'production', BABEL_RUNTIME_INVARIANTS: 'enforce' }), 'enforce');
  assert.equal(resolveRuntimeInvariantMode(undefined, { NODE_ENV: 'production', CI: '1' }), 'enforce');
  return { productionDefault: 'shadow', explicitEnforce: 'enforce', ciDefault: 'enforce' };
});
await probe('P08', 'transcribed-function + exact budget expression', 'finite session budget is narrowed to a repair slice', () => {
  const cap = computeCriticRepairCostCap({ spentUsd: 1, sessionMaxCostUsd: 10 });
  assert.equal(cap.capUsd, 1.75);
  assert.equal(effectiveCostCeiling(10, cap.capUsd), 1.75);
  return { requestedCeilingUsd: 10, spentUsd: 1, effectiveCeilingUsd: 1.75, remainingAllowanceUsd: 0.75 };
});
await probe('P09', 'transcribed-function + exact budget expression', 'mitigation: unlimited bypasses the finite repair cap', () => {
  const cap = computeCriticRepairCostCap({ spentUsd: 1, sessionMaxCostUsd: Infinity });
  assert.equal(effectiveCostCeiling(Infinity, cap.capUsd), Infinity);
  return { effectiveCeiling: 'Infinity', note: 'External experiment spend ceiling still necessary; not a recommendation for unbounded spending.' };
});
await probe('P10', 'transcribed-function', 'ordinary 30-minute task can acquire a 5-minute deadline after writing at minute two', () => {
  const cap = computePostWriteRepairWallMs({ elapsedMs: 120_000, sessionMaxWallMs: 1_800_000 });
  assert.equal(cap.capMs, 300_000);
  return { requestedWallMinutes: 30, firstWriteMinute: 2, effectiveDeadlineMinute: 5, note: 'Long-task authorization skips this wall shrink.' };
});
await probe('P11', 'exact source expression', 'zero changed files matches the delegated mutation predicate', () => {
  assert.equal(/\d+\s+changed/.test('0 changed'), true);
  return { summary: '0 changed', creditedByPredicate: true };
});
await probe('P12', 'reduced-control-flow model', 'premature EOF is compatible with synthesized completion', () => {
  const r = modelStreamTail({ answerText: 'Partial answer' });
  assert.equal(r.done.finishReason, 'stop');
  assert.equal(r.turn.type, 'completion');
  return r;
});
await probe('P13', 'reduced-control-flow model', 'error finish reason is not itself an engine failure', () => {
  const r = modelStreamTail({ answerText: '', finishReason: 'error' });
  assert.equal(r.turn.type, 'completion');
  assert.equal(r.turn.answer, 'OK');
  return r;
});
await probe('P14', 'reduced-control-flow model', 'partial JSON tool arguments become an empty object', () => {
  const r = modelStreamTail({ pendingCalls: [{ id: 'p', name: 'write_file', arguments: '{"path":"a' }] });
  assert.deepEqual(r.toolUses[0].input, {});
  return r;
});
await probe('P15', 'reduced-control-flow model', 'missing terminal event is classified as cancellation', async () => {
  async function* empty() {}
  const r = await modelConsumeTerminal(empty());
  assert.equal(r.outcome, 'CANCELLED');
  return r;
});
await probe('P16', 'reduced-control-flow model', 'an untyped persistence exception can become AGENT_FAILURE', async () => {
  async function* failed() { throw new Error('ENOSPC: failed evidence append'); }
  const r = await modelConsumeTerminal(failed());
  assert.equal(r.outcome, 'AGENT_FAILURE');
  return r;
});

const report = {
  auditDate: '2026-09-14', sourceRepository: 'gthgomez/Babel',
  sourceCommit: '18fd3f50b33525f41bba5e5ce0d233097b5b7413',
  finalMain: '017ec8cc28dbfbabf8138794096b1af00212b474',
  runtimeEquivalence: 'GitHub comparison: only the readiness report was added between audited runtime and final main.',
  nodeVersion: process.version,
  scope: 'Manual source transcriptions and explicitly labelled reduced control-flow models; NOT imported Babel or end-to-end tests.',
  networkCalls: 0, modelInferenceCalls: 0, assertionsSatisfied: results.filter(r => r.assertion === 'satisfied').length,
  assertionsFailed: results.filter(r => r.assertion === 'FAILED').length,
  interpretation: 'Assertions reproduce local failure mechanisms and positive controls; they do not certify runtime reachability, frequency, or benchmark readiness.',
  results,
};
const json = JSON.stringify(report, null, 2) + '\n';
const outFlag = process.argv.find(arg => arg === '--out' || arg.startsWith('--out='));
let outPath = null;
if (outFlag !== undefined) {
  outPath = outFlag.startsWith('--out=') ? outFlag.slice('--out='.length) : process.argv[process.argv.indexOf(outFlag) + 1];
  if (!outPath) {
    console.error('Error: --out requires a file path (use --out <path> or --out=<path>).');
    process.exit(2);
  }
}
process.stdout.write(json);
if (outPath !== null) writeFileSync(outPath, json);
if (report.assertionsFailed > 0) process.exitCode = 1;

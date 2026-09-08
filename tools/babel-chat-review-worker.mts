// Child-only entrypoint. The owner controller supplies a sanitized source root
// and an immutable installation; the child has no GitHub publishing capability.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatEngine } from '../babel-cli/src/agent/chatEngine.js';
import { runCliChatTask } from '../babel-cli/src/interactive/execution/chatCore.js';
import { isOpenCodeGoModel } from '../babel-cli/src/runners/openCodeGoApi.js';
import { babelReviewModelPolicy, babelReviewPrompt, parseBabelChatVerdict } from '../babel-cli/src/services/babelChatReview.js';
import { ObservedBabelReviewRunner, validateBabelReviewCalls } from '../babel-cli/src/services/babelReviewObserver.js';
import { babelRepairPrompt, parseBabelRepairProposal } from '../babel-cli/src/services/babelReviewRepair.js';

const source = process.env['BABEL_PROJECT_ROOT'];
const trustedRoot = process.env['BABEL_ROOT'];
const output = process.env['BABEL_REVIEW_OUTPUT'];
const model = process.env['BABEL_REVIEW_MODEL'];
const purpose = process.env['BABEL_REVIEW_PURPOSE'] ?? 'review';
if (!['review', 'repair_proposal'].includes(purpose)) throw new Error('REVIEW_PURPOSE_INVALID');
if (!source || !trustedRoot || !output || !model || !isOpenCodeGoModel(model)) throw new Error('REVIEW_LAUNCH_INVALID');
if (process.env['GH_TOKEN'] || process.env['GITHUB_TOKEN'] || process.env['BABEL_EXECUTION_PROFILE'] !== 'read_only_audit') throw new Error('REVIEW_CHILD_CAPABILITY_INVALID');
const manifest = JSON.parse(readFileSync(join(source, 'review-manifest.json'), 'utf8')) as { scope: string[]; execution_id: string };
const calls: Array<Record<string, unknown>> = [];
function persist(extra: Record<string, unknown>) {
  writeFileSync(output!, JSON.stringify({ schema_version: 1, harness: 'babel', mode: 'chat', purpose, execution_id: manifest.execution_id, model, monetary_cap: 'disabled', calls, ...extra }), { mode: 0o600 });
}
persist({ status: 'started' });
try {
  const runner = new ObservedBabelReviewRunner(model, call => { calls.push(call); persist({ status: 'running' }); }, { sessionId: manifest.execution_id, requestTimeoutMs: 120000 });
  let engine: ChatEngine | undefined;
  const attempts: Record<string, unknown>[] = [];
  const run = (task: string) => runCliChatTask({
    task, projectRoot: source, instructionRoot: trustedRoot,
    model, outputFormat: 'json', executionProfile: 'chat',
    engineFactory: options => engine ??= new ChatEngine({ ...options, runId: manifest.execution_id, providerRunner: runner, providerPolicy: babelReviewModelPolicy(model, trustedRoot), appendSystemPrompt: 'Integration output contract: this read-only investigation ends with exactly one JSON object matching the requested integration schema. No prose, Markdown fences, or trailing characters. Do not change findings or proposed replacements merely to satisfy formatting.' }),
  });
  const repair = purpose === 'repair_proposal';
  const parseAnswer = (payload: Record<string, unknown>) => repair ? parseBabelRepairProposal(payload, manifest.scope) : parseBabelChatVerdict(payload, manifest.scope);
  let result = await run(repair ? babelRepairPrompt(manifest.scope) : babelReviewPrompt(manifest.scope));
  attempts.push(result.payload);
  persist({ status: 'cli_completed', payload: result.payload, attempts, cli_exit_code: result.exitCode });
  let parsed;
  try { parsed = parseAnswer(result.payload); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // One format-only repair in the same reviewer session. Preserve the failed
    // answer and do not turn a model's blocker into an approval mechanically.
    result = await run(repair
      ? 'Restate your existing repair proposal as exactly one JSON object with summary and edits. Preserve the exact replacement strings. No Markdown, prose, backticks, or additional characters.'
      : 'Restate your existing review as exactly one JSON object with verdict, uncertain, reviewed_files, findings, blocking_findings. Preserve your findings and uncertainty. No Markdown, prose, backticks, or additional characters.');
    attempts.push(result.payload);
    persist({ status: 'cli_completed', payload: result.payload, attempts, format_repairs: 1 });
    parsed = parseAnswer(result.payload);
  }
  validateBabelReviewCalls(calls, model);
  persist({ status: repair ? 'repair_proposal_completed' : 'review_completed', payload: result.payload, attempts, ...(repair ? { proposal: parsed } : { verdict: parsed }) });
} catch (error) {
  // Preserve all partial CLI/provider artifacts without exposing error payloads.
  const prior = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
  const failure = error instanceof SyntaxError ? 'INVALID_VERDICT_JSON' : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CHAT_REVIEW_FAILURE';
  persist({ ...prior, status: 'review_failed', failure_code: failure });
  process.exitCode = 1;
}

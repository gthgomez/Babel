import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContextSync, resolveInstructionStackManifest } from '../src/compiler.js';
import { getRoutingConfidenceBand } from '../src/confidenceGate.js';
import {
  shouldHaltAutonomousWithoutApprovedPlan,
  shouldRefuseDirectModeWriteRequest,
} from '../src/pipeline.js';
import {
  ExecutionReportSchema,
  ExecutionSpecSchema,
  OrchestratorManifestSchema,
  PlanEnvelopeSchema,
  QaReviewSchema,
} from '../src/schemas/agentContracts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BABEL_ROOT = resolve(__dirname, '..', '..');
const FIXTURE_PATH = join(
  BABEL_ROOT,
  'tests',
  'fixtures',
  'instruction-behavior',
  'instruction-behavior-evals.json',
);

type FixtureRecord = Record<string, unknown>;

interface EvalCase extends FixtureRecord {
  id: string;
  behavior: string;
  manifest?: unknown;
  manifest_ref?: string;
  expect?: FixtureRecord;
  cases?: unknown[];
  replace?: Record<string, unknown>;
  task_context?: string;
  byte_limit?: number;
}

interface EvalSuite {
  schema_version: string;
  evals: EvalCase[];
}

function readSuite(): EvalSuite {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as EvalSuite;
  assert.equal(parsed.schema_version, '1.0');
  assert.ok(Array.isArray(parsed.evals), 'fixture suite must contain evals');
  return parsed;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fixtureById(suite: EvalSuite, id: string): EvalCase {
  const found = suite.evals.find((entry) => entry.id === id);
  assert.ok(found, `fixture '${id}' not found`);
  return found;
}

function getManifestFixture(suite: EvalSuite, entry: EvalCase): unknown {
  if (entry.manifest !== undefined) {
    return entry.manifest;
  }
  if (typeof entry.manifest_ref === 'string') {
    const referenced = fixtureById(suite, entry.manifest_ref);
    assert.ok(referenced.manifest !== undefined, `fixture '${entry.manifest_ref}' has no manifest`);
    return referenced.manifest;
  }
  throw new Error(`fixture '${entry.id}' has no manifest or manifest_ref`);
}

function setDottedPath(target: unknown, dottedPath: string, value: unknown): void {
  assert.ok(target !== null && typeof target === 'object', 'replacement target must be an object');
  const parts = dottedPath.split('.');
  let cursor = target as Record<string, unknown>;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    const next = cursor[part];
    assert.ok(next !== null && typeof next === 'object', `replacement path '${dottedPath}' is invalid`);
    cursor = next as Record<string, unknown>;
  }
}

function manifestForEval(suite: EvalSuite, entry: EvalCase): unknown {
  const manifest = deepClone(getManifestFixture(suite, entry));
  if (entry.replace) {
    for (const [path, value] of Object.entries(entry.replace)) {
      setDottedPath(manifest, path, value);
    }
  }
  return manifest;
}

function resolveManifest(suite: EvalSuite, entry: EvalCase) {
  const parsed = OrchestratorManifestSchema.parse(manifestForEval(suite, entry));
  return resolveInstructionStackManifest(parsed, BABEL_ROOT);
}

function selectedIds(resolved: ReturnType<typeof resolveInstructionStackManifest>): string[] {
  const ids = resolved.compiled_artifacts?.selected_entry_ids;
  assert.ok(ids && ids.length > 0, 'resolved manifest must contain selected_entry_ids');
  return ids;
}

function assertIncludesAll(actual: string[], expected: unknown, label: string): void {
  assert.ok(Array.isArray(expected), `${label} must be an array`);
  for (const id of expected) {
    assert.equal(typeof id, 'string');
    assert.equal(actual.includes(id), true, `${label} missing '${id}'`);
  }
}

function assertExcludesAll(actual: string[], expected: unknown, label: string): void {
  if (expected === undefined) {
    return;
  }
  assert.ok(Array.isArray(expected), `${label} must be an array`);
  for (const id of expected) {
    assert.equal(typeof id, 'string');
    assert.equal(actual.includes(id), false, `${label} unexpectedly included '${id}'`);
  }
}

function assertRelativeOrder(actual: string[], expected: unknown): void {
  assert.ok(Array.isArray(expected), 'selected_entry_order must be an array');
  let previousIndex = -1;
  for (const id of expected) {
    assert.equal(typeof id, 'string');
    const currentIndex = actual.indexOf(id);
    assert.notEqual(currentIndex, -1, `selected order missing '${id}'`);
    assert.ok(currentIndex > previousIndex, `'${id}' must appear after the prior expected entry`);
    previousIndex = currentIndex;
  }
}

function runRoutingOrSkillEval(suite: EvalSuite, entry: EvalCase): void {
  const resolved = resolveManifest(suite, entry);
  const ids = selectedIds(resolved);
  const expect = entry.expect ?? {};

  assertIncludesAll(ids, expect['selected_entry_ids_include'], `${entry.id}.selected_entry_ids_include`);
  assertExcludesAll(ids, expect['selected_entry_ids_exclude'], `${entry.id}.selected_entry_ids_exclude`);

  if (expect['pipeline_mode']) {
    assert.equal(resolved.analysis.pipeline_mode, expect['pipeline_mode']);
  }
  if (expect['compilation_state']) {
    assert.equal(resolved.compilation_state, expect['compilation_state']);
  }
}

function runPromptCompilationEval(suite: EvalSuite, entry: EvalCase): void {
  const resolved = resolveManifest(suite, entry);
  const ids = selectedIds(resolved);
  const expect = entry.expect ?? {};
  assertRelativeOrder(ids, expect['selected_entry_order']);

  const promptManifest = resolved.prompt_manifest;
  assert.ok(promptManifest.length > 0, 'compiled prompt_manifest must not be empty');
  for (const filePath of promptManifest) {
    assert.equal(existsSync(filePath), true, `compiled prompt path is missing: ${filePath}`);
  }

  const stubs = new Map<string, string>();
  promptManifest.forEach((filePath, index) => {
    stubs.set(filePath, `eval-stub-${index}`);
  });

  const taskContext = typeof entry.task_context === 'string' ? entry.task_context : 'Instruction behavior eval task.';
  const compiled = compileContextSync(promptManifest, taskContext, undefined, stubs);
  const expectedNeedles = expect['compiled_context_contains'];
  assert.ok(Array.isArray(expectedNeedles), 'compiled_context_contains must be an array');
  for (const needle of expectedNeedles) {
    assert.equal(typeof needle, 'string');
    assert.equal(compiled.includes(needle), true, `compiled context missing '${needle}'`);
  }
}

function parseWithNamedSchema(schemaName: string, payload: unknown): void {
  switch (schemaName) {
    case 'PlanEnvelope':
      PlanEnvelopeSchema.parse(payload);
      return;
    case 'ExecutionSpec':
      ExecutionSpecSchema.parse(payload);
      return;
    case 'ExecutionReport':
      ExecutionReportSchema.parse(payload);
      return;
    default:
      throw new Error(`unknown schema '${schemaName}'`);
  }
}

function didParseSchema(schemaName: string, payload: unknown): boolean {
  try {
    parseWithNamedSchema(schemaName, payload);
    return true;
  } catch {
    return false;
  }
}

function runContractSeparationEval(entry: EvalCase): void {
  assert.ok(Array.isArray(entry.cases), `${entry.id}.cases must be an array`);
  for (const rawCase of entry.cases) {
    const testCase = rawCase as FixtureRecord;
    assert.equal(typeof testCase['schema'], 'string');
    assert.equal(
      didParseSchema(testCase['schema'], testCase['payload']),
      testCase['should_pass'],
      `${entry.id}: ${testCase['name'] as string}`,
    );
  }
}

function runQaJsonEval(entry: EvalCase): void {
  assert.ok(Array.isArray(entry.cases), `${entry.id}.cases must be an array`);
  for (const rawCase of entry.cases) {
    const testCase = rawCase as FixtureRecord;
    let didPass = false;
    try {
      const payload = typeof testCase['raw'] === 'string'
        ? JSON.parse(testCase['raw'])
        : testCase['payload'];
      QaReviewSchema.parse(payload);
      didPass = true;
    } catch {
      didPass = false;
    }
    assert.equal(didPass, testCase['should_pass'], `${entry.id}: ${testCase['name'] as string}`);
  }
}

function runExecutorHaltRefusalEval(entry: EvalCase): void {
  assert.ok(Array.isArray(entry.cases), `${entry.id}.cases must be an array`);
  for (const rawCase of entry.cases) {
    const testCase = rawCase as FixtureRecord;
    if (testCase['helper'] === 'shouldRefuseDirectModeWriteRequest') {
      const args = testCase['args'] as [string, number];
      assert.equal(shouldRefuseDirectModeWriteRequest(args[0], args[1]), testCase['expected']);
      continue;
    }
    if (testCase['helper'] === 'shouldHaltAutonomousWithoutApprovedPlan') {
      const args = testCase['args'] as [string, null];
      assert.equal(shouldHaltAutonomousWithoutApprovedPlan(args[0], args[1]), testCase['expected']);
      continue;
    }
    if (testCase['schema'] === 'ExecutionReport') {
      assert.equal(didParseSchema('ExecutionReport', testCase['payload']), testCase['should_pass']);
      continue;
    }
    throw new Error(`unknown executor halt/refusal case '${testCase['name'] as string}'`);
  }
}

function runDeadReferenceEval(suite: EvalSuite, entry: EvalCase): void {
  try {
    resolveManifest(suite, entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message.includes(String(entry['expect_error_contains'])), true, message);
    return;
  }
  throw new Error(`${entry.id} unexpectedly resolved`);
}

function classifyCurrentnessClaim(testCase: FixtureRecord): string {
  const hasSource = typeof testCase['source_url'] === 'string' && testCase['source_url'].length > 0;
  if (testCase['reported_status'] === 'CONFIRMED' && hasSource) {
    return 'CONFIRMED';
  }
  return 'UNKNOWN';
}

function runCurrentnessAuditEval(entry: EvalCase): void {
  assert.ok(Array.isArray(entry.cases), `${entry.id}.cases must be an array`);
  for (const rawCase of entry.cases) {
    const testCase = rawCase as FixtureRecord;
    assert.equal(
      classifyCurrentnessClaim(testCase),
      testCase['expected_status'],
      `${entry.id}: ${testCase['claim'] as string}`,
    );
  }
}

function runCodexAgentsCapEval(entry: EvalCase): void {
  assert.equal(typeof entry.byte_limit, 'number', `${entry.id}.byte_limit must be a number`);
  assert.ok(Array.isArray(entry.cases), `${entry.id}.cases must be an array`);
  for (const rawCase of entry.cases) {
    const testCase = rawCase as FixtureRecord;
    const relativePath = testCase['path'];
    assert.equal(typeof relativePath, 'string');
    const absolutePath = join(BABEL_ROOT, relativePath as string);
    assert.equal(existsSync(absolutePath), true, `${relativePath as string} must exist`);
    const withinLimit = statSync(absolutePath).size <= entry.byte_limit;
    assert.equal(withinLimit, testCase['expected_within_limit'], `${relativePath as string} byte cap expectation failed`);
  }
}

function expectedQuickSpecMode(testCase: FixtureRecord): string {
  const initialMode = String(testCase['pipeline_mode']);
  const requestedTargetCount = Number(testCase['requested_target_count']);
  const confidence = Number(testCase['routing_confidence']);
  if (shouldRefuseDirectModeWriteRequest(initialMode, requestedTargetCount)) {
    return 'verified';
  }
  if (initialMode === 'direct' && getRoutingConfidenceBand(confidence) === 'medium') {
    return 'verified';
  }
  return initialMode;
}

function runQuickSpecEval(entry: EvalCase): void {
  assert.ok(Array.isArray(entry.cases), `${entry.id}.cases must be an array`);
  for (const rawCase of entry.cases) {
    const testCase = rawCase as FixtureRecord;
    if (testCase['expected_refusal'] !== undefined) {
      assert.equal(
        shouldRefuseDirectModeWriteRequest(String(testCase['pipeline_mode']), Number(testCase['requested_target_count'])),
        testCase['expected_refusal'],
        `${entry.id}: ${testCase['name'] as string} refusal expectation failed`,
      );
    }
    if (testCase['expected_confidence_band'] !== undefined) {
      assert.equal(
        getRoutingConfidenceBand(Number(testCase['routing_confidence'])),
        testCase['expected_confidence_band'],
        `${entry.id}: ${testCase['name'] as string} confidence band expectation failed`,
      );
    }
    assert.equal(
      expectedQuickSpecMode(testCase),
      testCase['expected_pipeline_mode'],
      `${entry.id}: ${testCase['name'] as string} pipeline mode expectation failed`,
    );
  }
}

function main(): void {
  const suite = readSuite();
  const exercised: string[] = [];

  for (const entry of suite.evals) {
    switch (entry.behavior) {
      case 'routing_selection':
      case 'skill_selection':
        runRoutingOrSkillEval(suite, entry);
        break;
      case 'prompt_compilation':
        runPromptCompilationEval(suite, entry);
        break;
      case 'contract_separation':
        runContractSeparationEval(entry);
        break;
      case 'qa_json_contract':
        runQaJsonEval(entry);
        break;
      case 'executor_halt_refusal':
        runExecutorHaltRefusalEval(entry);
        break;
      case 'dead_reference_detection':
        runDeadReferenceEval(suite, entry);
        break;
      case 'currentness_audit':
        runCurrentnessAuditEval(entry);
        break;
      case 'codex_agents_loading_cap':
        runCodexAgentsCapEval(entry);
        break;
      case 'quickspec_fast_path':
        runQuickSpecEval(entry);
        break;
      default:
        throw new Error(`unknown eval behavior '${entry.behavior}'`);
    }
    exercised.push(entry.id);
  }

  console.log(`instruction behavior evals passed (${exercised.length} fixtures): ${exercised.join(', ')}`);
}

main();

import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatTurnTelemetryCollector } from './chatTurnTelemetry.js';

test('only a completed useful tool action and a committed verified outcome produce timings', () => {
  let now = 100;
  const telemetry = new ChatTurnTelemetryCollector(now, () => now);
  now = 110;
  telemetry.recordUsefulToolAction({ action: 'read_file', succeeded: false });
  telemetry.recordUsefulToolAction({ action: 'read_file', succeeded: true, preDispatchNoEffect: true });
  telemetry.recordUsefulToolAction({ action: 'run_command', succeeded: true, processExecuted: false });
  now = 140;
  telemetry.recordUsefulToolAction({ action: 'read_file', succeeded: true });
  now = 160;
  telemetry.recordUsefulToolAction({ action: 'test_run', succeeded: true, processExecuted: true, processCompleted: true });
  now = 200;
  const record = telemetry.finalize({ turnId: 'fixture', taskClass: 'repair', cumulativeSessionTokens: 0, verifiedOutcome: true });
  assert.equal(record.timing.firstUsefulToolCompletedMs, 40);
  assert.equal(record.timing.verifiedOutcomeMs, 100);
});

test('missing work, incomplete processes, and unverified outcomes do not become fast successes', () => {
  let now = 300;
  const telemetry = new ChatTurnTelemetryCollector(now, () => now);
  now = 310;
  telemetry.recordUsefulToolAction({ action: 'run_command', succeeded: true, processExecuted: true, processCompleted: false });
  telemetry.recordUsefulToolAction({ action: 'unknown_tool', succeeded: true });
  now = 330;
  const record = telemetry.finalize({ turnId: 'fixture', taskClass: 'repair', cumulativeSessionTokens: 0 });
  assert.equal(record.timing.firstUsefulToolCompletedMs, null);
  assert.equal(record.timing.verifiedOutcomeMs, null);
});

test('preparation and first provider phases are timed independently without inventing missing events', () => {
  let now = 100;
  const telemetry = new ChatTurnTelemetryCollector(now, () => now);
  const admission = telemetry.startPreparationSpan('objectiveAdmission');
  now = 115; admission.end(); admission.end();
  const repository = telemetry.startPreparationSpan('repositoryContext');
  now = 145; repository.end();
  const prompt = telemetry.startPreparationSpan('systemPrompt');
  now = 150; prompt.end();
  now = 170; telemetry.markProviderPhase('request_created');
  now = 180; telemetry.markProviderPhase('request_dispatched');
  now = 185; telemetry.markProviderPhase('request_created');
  now = 210; telemetry.markProviderPhase('response_started');
  now = 250;
  const {timing} = telemetry.finalize({turnId:'fixture',taskClass:'repair',cumulativeSessionTokens:0});
  assert.equal(timing.objectiveAdmissionMs,15);
  assert.equal(timing.repositoryContextMs,30);
  assert.equal(timing.systemPromptPreparationMs,5);
  assert.equal(timing.providerRequestCreatedMs,70);
  assert.equal(timing.providerDispatchStartedMs,80);
  assert.equal(timing.providerResponseStartedMs,110);
  const missing = new ChatTurnTelemetryCollector(100,()=>200).finalize({turnId:'missing',taskClass:'chat',cumulativeSessionTokens:0});
  assert.equal(missing.timing.providerDispatchStartedMs,null);
  assert.equal(missing.timing.repositoryContextMs,null);
});

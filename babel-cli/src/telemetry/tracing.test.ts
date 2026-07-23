import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PipelineTrace,
  enableInMemoryTelemetryForTests,
  getFinishedTestSpans,
  resetTelemetryForTests,
} from './tracing.js';

function baseTraceOptions(runDir: string) {
  return {
    runDir,
    orchestratorVersion: '9.0',
    requestedMode: 'verified',
    metadata: {
      hasSessionStartPath: false,
      hasLocalLearningRoot: false,
    },
  };
}

async function withTelemetryPolicy<T>(optIn: boolean, fn: () => Promise<T>): Promise<T> {
  const previous = {
    enabled: process.env['BABEL_OTEL_ENABLED'],
    endpoint: process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'],
    service: process.env['BABEL_OTEL_SERVICE_NAME'],
    explicit: process.env['BABEL_ENTERPRISE_POLICY_PATH'],
    user: process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'],
    admin: process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'],
  };
  const root = mkdtempSync(join(tmpdir(), 'babel-telemetry-policy-'));
  const policyPath = join(root, 'enterprise-policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      schema_version: 1,
      telemetry: {
        opt_in: optIn,
      },
    }),
    'utf-8',
  );
  process.env['BABEL_OTEL_ENABLED'] = 'true';
  process.env['BABEL_OTEL_SERVICE_NAME'] = 'babel-cli-test';
  delete process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'];
  process.env['BABEL_ENTERPRISE_POLICY_PATH'] = policyPath;
  process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = join(root, 'missing-user-policy.json');
  delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];

  try {
    await enableInMemoryTelemetryForTests();
    return await fn();
  } finally {
    await resetTelemetryForTests();
    if (previous.enabled === undefined) delete process.env['BABEL_OTEL_ENABLED'];
    else process.env['BABEL_OTEL_ENABLED'] = previous.enabled;
    if (previous.endpoint === undefined) delete process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'];
    else process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'] = previous.endpoint;
    if (previous.service === undefined) delete process.env['BABEL_OTEL_SERVICE_NAME'];
    else process.env['BABEL_OTEL_SERVICE_NAME'] = previous.service;
    if (previous.explicit === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_PATH'] = previous.explicit;
    if (previous.user === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = previous.user;
    if (previous.admin === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] = previous.admin;
  }
}

test('enterprise telemetry policy blocks OTel when opt_in is false', async () => {
  await withTelemetryPolicy(false, async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-trace-run-'));
    const trace = await PipelineTrace.start(baseTraceOptions(runDir));
    assert.equal(trace.enabled, false);
    assert.equal(trace.writeSummary().enabled, false);
    assert.equal(getFinishedTestSpans().length, 0);
  });
});

test('enterprise telemetry policy allows OTel when opt_in is true', async () => {
  await withTelemetryPolicy(true, async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-trace-run-'));
    const trace = await PipelineTrace.start(baseTraceOptions(runDir));
    assert.equal(trace.enabled, true);
    await trace.finish('COMPLETE');
    assert.equal(getFinishedTestSpans().length, 1);
  });
});

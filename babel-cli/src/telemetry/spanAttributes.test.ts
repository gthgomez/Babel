/**
 * Tests for OTel span attributes added by chat and MCP operations.
 *
 * These tests verify that the attributes are correctly set on spans created
 * using the same `trace.getTracer()` pattern that chatEngine.ts and
 * mcpTransport.ts use. They do NOT execute the full chat or MCP runtime —
 * they test at the OTel API level, which is the same contract the runtime
 * depends on.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';

import { trace, SpanStatusCode } from '@opentelemetry/api';

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import {
  PipelineTrace,
  enableInMemoryTelemetryForTests,
  getFinishedTestSpans,
  resetTelemetryForTests,
} from './tracing.js';

/** Find the most recently ended span with the given name. */
function findLatestSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i]!.name === name) return spans[i]!;
  }
  return undefined;
}

const TELEMETRY_ROOT = mkdtempSync(join(tmpdir(), 'babel-span-attr-'));
const POLICY_PATH = join(TELEMETRY_ROOT, 'enterprise-policy.json');

/** Saved env vars to restore in after(). */
let savedEnv: Record<string, string | undefined>;

before(() => {
  savedEnv = {
    enabled: process.env['BABEL_OTEL_ENABLED'],
    endpoint: process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'],
    service: process.env['BABEL_OTEL_SERVICE_NAME'],
    explicit: process.env['BABEL_ENTERPRISE_POLICY_PATH'],
    user: process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'],
    admin: process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'],
  };
  writeFileSync(
    POLICY_PATH,
    JSON.stringify({
      schema_version: 1,
      telemetry: { opt_in: true },
    }),
    'utf-8',
  );
  process.env['BABEL_OTEL_ENABLED'] = 'true';
  process.env['BABEL_OTEL_SERVICE_NAME'] = 'babel-cli-test';
  delete process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'];
  process.env['BABEL_ENTERPRISE_POLICY_PATH'] = POLICY_PATH;
  process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = join(TELEMETRY_ROOT, 'missing-user-policy.json');
  delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
});

after(async () => {
  await resetTelemetryForTests();
  if (savedEnv.enabled === undefined) delete process.env['BABEL_OTEL_ENABLED'];
  else process.env['BABEL_OTEL_ENABLED'] = savedEnv.enabled;
  if (savedEnv.endpoint === undefined) delete process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'];
  else process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'] = savedEnv.endpoint;
  if (savedEnv.service === undefined) delete process.env['BABEL_OTEL_SERVICE_NAME'];
  else process.env['BABEL_OTEL_SERVICE_NAME'] = savedEnv.service;
  if (savedEnv.explicit === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
  else process.env['BABEL_ENTERPRISE_POLICY_PATH'] = savedEnv.explicit;
  if (savedEnv.user === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
  else process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = savedEnv.user;
  if (savedEnv.admin === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
  else process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] = savedEnv.admin;
});

describe('chat and MCP span attributes', () => {
  before(async () => {
    await enableInMemoryTelemetryForTests();
    // Bootstrap the global OTel provider so trace.getTracer() returns a
    // real tracer connected to the in-memory exporter.
    const boot = await PipelineTrace.start({
      runDir: TELEMETRY_ROOT,
      orchestratorVersion: '9.0',
      requestedMode: 'test',
      metadata: { hasSessionStartPath: false, hasLocalLearningRoot: false },
    });
    await boot.finish('BOOT');
  });

  // ── babel.chat.turn ──────────────────────────────────────────────────────

  it('sets babel.chat.turn attribute on chat turn spans (tool_calls)', () => {
    const tracer = trace.getTracer('babel-cli', '1.0.0');
    const span = tracer.startSpan('babel.chat.turn');
    span.setAttribute('babel.chat.turn', '1:tool_calls');
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const spans = getFinishedTestSpans();
    const chatSpan = findLatestSpan(spans, 'babel.chat.turn');
    assert.ok(chatSpan, 'babel.chat.turn span should exist');
    assert.equal(chatSpan!.attributes['babel.chat.turn'], '1:tool_calls');
  });

  it('sets babel.chat.turn attribute on chat turn spans (completion)', () => {
    const tracer = trace.getTracer('babel-cli', '1.0.0');
    const span = tracer.startSpan('babel.chat.turn');
    span.setAttribute('babel.chat.turn', '3:completion');
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const spans = getFinishedTestSpans();
    const chatSpan = findLatestSpan(spans, 'babel.chat.turn');
    assert.ok(chatSpan, 'babel.chat.turn span should exist');
    assert.equal(chatSpan!.attributes['babel.chat.turn'], '3:completion');
  });

  it('supports {turn}:{type} convention for babel.chat.turn', () => {
    const tracer = trace.getTracer('babel-cli', '1.0.0');
    const span = tracer.startSpan('babel.chat.turn');
    span.setAttribute('babel.chat.turn', '7:error');
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();

    const spans = getFinishedTestSpans();
    const chatSpan = findLatestSpan(spans, 'babel.chat.turn');
    assert.ok(chatSpan, 'babel.chat.turn span should exist');
    assert.equal(chatSpan!.attributes['babel.chat.turn'], '7:error');
  });

  // ── babel.mcp.server + babel.mcp.tool ────────────────────────────────────

  it('sets babel.mcp.server attribute on MCP request spans', () => {
    const tracer = trace.getTracer('babel-cli', '1.0.0');
    const span = tracer.startSpan('babel.mcp.request', {
      attributes: { 'babel.mcp.server': 'knowledge-graph' },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const spans = getFinishedTestSpans();
    const mcpSpan = findLatestSpan(spans, 'babel.mcp.request');
    assert.ok(mcpSpan, 'babel.mcp.request span should exist');
    assert.equal(mcpSpan!.attributes['babel.mcp.server'], 'knowledge-graph');
  });

  it('sets babel.mcp.tool attribute on tools/call MCP request spans', () => {
    const tracer = trace.getTracer('babel-cli', '1.0.0');
    const span = tracer.startSpan('babel.mcp.request', {
      attributes: {
        'babel.mcp.server': 'filesystem',
        'babel.mcp.tool': 'read_file',
      },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const spans = getFinishedTestSpans();
    const mcpSpan = findLatestSpan(spans, 'babel.mcp.request');
    assert.ok(mcpSpan, 'babel.mcp.request span should exist');
    assert.equal(mcpSpan!.attributes['babel.mcp.server'], 'filesystem');
    assert.equal(mcpSpan!.attributes['babel.mcp.tool'], 'read_file');
  });

  it('omits babel.mcp.tool for non-tools/call MCP requests', () => {
    const tracer = trace.getTracer('babel-cli', '1.0.0');
    const span = tracer.startSpan('babel.mcp.request', {
      attributes: { 'babel.mcp.server': 'knowledge-graph' },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const spans = getFinishedTestSpans();
    const mcpSpan = findLatestSpan(spans, 'babel.mcp.request');
    assert.ok(mcpSpan, 'babel.mcp.request span should exist');
    assert.equal(mcpSpan!.attributes['babel.mcp.tool'], undefined);
  });

  // ── Attribute type convention ────────────────────────────────────────────

  it('ensures all babel. span attributes are strings (OTel convention)', () => {
    const tracer = trace.getTracer('babel-cli', '1.0.0');

    const chatSpan = tracer.startSpan('babel.chat.turn');
    chatSpan.setAttribute('babel.chat.turn', '2:tool_calls');
    chatSpan.end();

    const mcpSpan = tracer.startSpan('babel.mcp.request', {
      attributes: {
        'babel.mcp.server': 'filesystem',
        'babel.mcp.tool': 'write_file',
      },
    });
    mcpSpan.end();

    const spans = getFinishedTestSpans();
    const babelSpans = spans.filter(
      (s) => s.name === 'babel.chat.turn' || s.name === 'babel.mcp.request',
    );
    assert.ok(babelSpans.length >= 2, 'should have at least 2 babel spans in exporter');

    for (const span of babelSpans) {
      for (const [key, value] of Object.entries(span.attributes)) {
        if (key.startsWith('babel.')) {
          assert.equal(
            typeof value,
            'string',
            `attribute ${key} must be a string, got ${typeof value}: ${value}`,
          );
        }
      }
    }
  });
});

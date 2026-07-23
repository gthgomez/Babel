import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emitAgentEvent,
  setAgentEventHandler,
  type AgentEvent,
  type AgentEventHandler,
} from './events.js';

describe('events', () => {
  it('delivers events to a registered handler', () => {
    const received: AgentEvent[] = [];
    const handler: AgentEventHandler = (event) => {
      received.push(event);
    };
    setAgentEventHandler(handler);

    try {
      emitAgentEvent({
        type: 'policy_decision',
        action: 'read_file',
        decision: 'allow',
        preset: 'read_only',
      });
      emitAgentEvent({
        type: 'scope_violation',
        action: 'write_file',
        target: '/outside/path',
        projectRoot: '/project',
        preset: 'read_only',
      });

      assert.equal(received.length, 2);
      assert.equal(received[0]?.type, 'policy_decision');
      assert.equal(received[1]?.type, 'scope_violation');
    } finally {
      setAgentEventHandler(null);
    }
  });

  it('stops delivering events after handler is set to null', () => {
    const received: AgentEvent[] = [];
    setAgentEventHandler((event) => {
      received.push(event);
    });
    emitAgentEvent({
      type: 'malformed_config',
      source: 'test',
      detail: 'before clear',
      severity: 'warn',
    });
    setAgentEventHandler(null);
    emitAgentEvent({
      type: 'malformed_config',
      source: 'test',
      detail: 'after clear',
      severity: 'warn',
    });

    assert.equal(received.length, 1);
    const firstEvent = received[0];
    assert.equal(firstEvent?.type, 'malformed_config');
    if (firstEvent?.type === 'malformed_config') {
      assert.equal(firstEvent.detail, 'before clear');
    }
  });

  it('handles handler errors gracefully (does not throw)', () => {
    setAgentEventHandler(() => {
      throw new Error('handler crash');
    });

    // Should not throw
    assert.doesNotThrow(() => {
      emitAgentEvent({
        type: 'circuit_breaker',
        reason: 'test',
        consecutiveBlocks: 5,
      });
    });

    setAgentEventHandler(null);
  });

  it('delivers all event types with correct payload shapes', () => {
    const received: AgentEvent[] = [];
    setAgentEventHandler((event) => {
      received.push(event);
    });

    try {
      emitAgentEvent({
        type: 'policy_decision',
        action: 'read_file',
        decision: 'allow',
        preset: 'read_only',
        rule: 'test_rule',
        runId: 'run-1',
        agentId: 'agent-1',
      });
      emitAgentEvent({
        type: 'tool_timeout',
        action: 'run_command',
        tool: 'shell_exec',
        timeoutMs: 5000,
      });
      emitAgentEvent({
        type: 'circuit_breaker',
        reason: '5 consecutive blocks',
        consecutiveBlocks: 5,
      });

      assert.equal(received.length, 3);

      const policy = received[0];
      assert.equal(policy?.type, 'policy_decision');
      if (policy?.type === 'policy_decision') {
        assert.equal(policy.action, 'read_file');
        assert.equal(policy.decision, 'allow');
        assert.equal(policy.preset, 'read_only');
      }

      const timeout = received[1];
      assert.equal(timeout?.type, 'tool_timeout');
      if (timeout?.type === 'tool_timeout') {
        assert.equal(timeout.tool, 'shell_exec');
        assert.equal(timeout.timeoutMs, 5000);
      }

      const breaker = received[2];
      assert.equal(breaker?.type, 'circuit_breaker');
      if (breaker?.type === 'circuit_breaker') {
        assert.equal(breaker.consecutiveBlocks, 5);
      }
    } finally {
      setAgentEventHandler(null);
    }
  });
});

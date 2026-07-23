// ─── WorkflowEngine Tests ──────────────────────────────────────────────────
// Unit tests for topological sort, conditional edge resolution, and
// end-to-end workflow execution with a mock ChatEngineFactory.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkflowEngine,
  topologicalSort,
  resolveConditionalEdges,
} from '../orchestrator/workflowEngine.js';

import type {
  ChatEngineFactory,
  WorkflowDefinition,
  WorkflowNodeConfig,
  WorkflowNodeResult,
} from '../orchestrator/workflowNode.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Create a minimal node config. */
function node(
  id: string,
  task?: string,
  opts?: Partial<WorkflowNodeConfig>,
): WorkflowNodeConfig {
  return {
    id,
    task: task ?? `Task for ${id}`,
    ...opts,
  };
}

/** Build a mock ChatEngineFactory that returns completed answers. */
function mockFactory(
  answers?: Map<string, string>,
): ChatEngineFactory {
  return ({ node: n }) => {
    const answer = answers?.get(n.id) ?? `Mock answer for ${n.id}`;
    return {
      submitMessage: async (_input: string, _callbacks: any) => ({
        status: 'completed' as const,
        answer,
        usage: { totalCostUSD: 0.01, totalTokens: 100, totalInputTokens: 50, totalOutputTokens: 50 },
        conversation: [],
      }),
      cancel: () => {},
      // Stub remaining ChatEngine surface
      getConversation: () => [],
      clearSystemPromptCache: () => {},
    } as any;
  };
}

/** Build a mock factory where specific nodes fail. */
function mockFactoryWithFailures(
  failures: Set<string>,
): ChatEngineFactory {
  return ({ node: n }) => {
    if (failures.has(n.id)) {
      return {
        submitMessage: async () => ({
          status: 'failed' as const,
          answer: 'Simulated failure',
          usage: { totalCostUSD: 0, totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 },
          conversation: [],
        }),
        cancel: () => {},
        getConversation: () => [],
        clearSystemPromptCache: () => {},
      } as any;
    }
    return mockFactory()({ node: n, projectRoot: '' });
  };
}

/** Build a minimal WorkflowDefinition. */
function def(
  id: string,
  nodes: WorkflowNodeConfig[],
  opts?: Partial<WorkflowDefinition>,
): WorkflowDefinition {
  return {
    id,
    nodes,
    projectRoot: '/test/project',
    ...opts,
  };
}

// ─── topologicalSort ──────────────────────────────────────────────────────

describe('topologicalSort', () => {
  it('linear DAG: A → B → C', () => {
    const nodes = [
      node('A'),
      node('B', undefined, { dependsOn: [{ from: 'A' }] }),
      node('C', undefined, { dependsOn: [{ from: 'B' }] }),
    ];
    const levels = topologicalSort(nodes);
    assert.deepStrictEqual(levels, [['A'], ['B'], ['C']]);
  });

  it('parallel roots: A, B roots; C depends on both', () => {
    const nodes = [
      node('A'),
      node('B'),
      node('C', undefined, {
        dependsOn: [{ from: 'A' }, { from: 'B' }],
      }),
    ];
    const levels = topologicalSort(nodes);
    // A and B can run in parallel; C after both
    assert.equal(levels.length, 2);
    assert.deepStrictEqual(levels[0]!.sort(), ['A', 'B']);
    assert.deepStrictEqual(levels[1], ['C']);
  });

  it('diamond DAG: A → (B, C) → D', () => {
    const nodes = [
      node('A'),
      node('B', undefined, { dependsOn: [{ from: 'A' }] }),
      node('C', undefined, { dependsOn: [{ from: 'A' }] }),
      node('D', undefined, {
        dependsOn: [{ from: 'B' }, { from: 'C' }],
      }),
    ];
    const levels = topologicalSort(nodes);
    assert.deepStrictEqual(levels, [['A'], ['B', 'C'], ['D']]);
  });

  it('cycle detection: A → B → A', () => {
    const nodes = [
      node('A', undefined, { dependsOn: [{ from: 'B' }] }),
      node('B', undefined, { dependsOn: [{ from: 'A' }] }),
    ];
    assert.throws(
      () => topologicalSort(nodes),
      /Cycle detected/,
    );
  });

  it('missing node reference', () => {
    const nodes = [
      node('A', undefined, { dependsOn: [{ from: 'NONEXISTENT' }] }),
    ];
    assert.throws(
      () => topologicalSort(nodes),
      /unknown node.*NONEXISTENT/,
    );
  });

  it('on_failure edges contribute to in-degree', () => {
    // B depends on A with on_failure — B should still wait for A
    const nodes = [
      node('A'),
      node('B', undefined, {
        dependsOn: [{ from: 'A', condition: 'on_failure' }],
      }),
    ];
    const levels = topologicalSort(nodes);
    // B should be in level 1 (waits for A), not level 0
    assert.deepStrictEqual(levels, [['A'], ['B']]);
  });

  it('single node', () => {
    const levels = topologicalSort([node('A')]);
    assert.deepStrictEqual(levels, [['A']]);
  });

  it('complex mixed-condition DAG', () => {
    // A (root)
    // B depends on A (on_success)
    // C depends on A (on_failure) — recovery path
    // D depends on B
    // E depends on B and C (always)
    const nodes = [
      node('A'),
      node('B', undefined, { dependsOn: [{ from: 'A', condition: 'on_success' }] }),
      node('C', undefined, { dependsOn: [{ from: 'A', condition: 'on_failure' }] }),
      node('D', undefined, { dependsOn: [{ from: 'B' }] }),
      node('E', undefined, { dependsOn: [{ from: 'B' }, { from: 'C' }] }),
    ];
    const levels = topologicalSort(nodes);
    // A in level 0, B+C in level 1, D+E in level 2
    assert.equal(levels.length, 3);
    assert.deepStrictEqual(levels[0], ['A']);
    assert.deepStrictEqual(levels[1]!.sort(), ['B', 'C']);
    assert.deepStrictEqual(levels[2]!.sort(), ['D', 'E']);
  });
});

// ─── resolveConditionalEdges ──────────────────────────────────────────────

describe('resolveConditionalEdges', () => {
  it('on_success: completed upstream → proceed', () => {
    const nodes = [
      node('B', undefined, { dependsOn: [{ from: 'A', condition: 'on_success' }] }),
    ];
    const results = new Map<string, WorkflowNodeResult>();
    results.set('A', {
      nodeId: 'A', status: 'completed', answer: 'done',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });

    const { proceed, skipped } = resolveConditionalEdges(nodes, results);
    assert.equal(proceed.length, 1);
    assert.equal(skipped.length, 0);
  });

  it('on_success: failed upstream → skip', () => {
    const nodes = [
      node('B', undefined, { dependsOn: [{ from: 'A', condition: 'on_success' }] }),
    ];
    const results = new Map<string, WorkflowNodeResult>();
    results.set('A', {
      nodeId: 'A', status: 'failed', answer: '', error: 'boom',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });

    const { proceed, skipped } = resolveConditionalEdges(nodes, results);
    assert.equal(proceed.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.node.id, 'B');
    assert.ok(skipped[0]!.reason.includes('did not complete successfully'));
  });

  it('on_failure: failed upstream → proceed', () => {
    const nodes = [
      node('B', undefined, { dependsOn: [{ from: 'A', condition: 'on_failure' }] }),
    ];
    const results = new Map<string, WorkflowNodeResult>();
    results.set('A', {
      nodeId: 'A', status: 'failed', answer: '', error: 'boom',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });

    const { proceed, skipped } = resolveConditionalEdges(nodes, results);
    assert.equal(proceed.length, 1);
    assert.equal(skipped.length, 0);
  });

  it('on_failure: completed upstream → skip', () => {
    const nodes = [
      node('B', undefined, { dependsOn: [{ from: 'A', condition: 'on_failure' }] }),
    ];
    const results = new Map<string, WorkflowNodeResult>();
    results.set('A', {
      nodeId: 'A', status: 'completed', answer: 'done',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });

    const { proceed, skipped } = resolveConditionalEdges(nodes, results);
    assert.equal(proceed.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.node.id, 'B');
    assert.ok(skipped[0]!.reason.includes('did not fail'));
  });

  it('always: failed upstream → still proceed', () => {
    const nodes = [
      node('B', undefined, { dependsOn: [{ from: 'A', condition: 'always' }] }),
    ];
    const results = new Map<string, WorkflowNodeResult>();
    results.set('A', {
      nodeId: 'A', status: 'failed', answer: '', error: 'boom',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });

    const { proceed, skipped } = resolveConditionalEdges(nodes, results);
    assert.equal(proceed.length, 1);
    assert.equal(skipped.length, 0);
  });

  it('mixed conditions on multiple upstreams', () => {
    // C depends on A (on_success) and B (on_failure)
    // A completed, B failed → both conditions met → proceed
    const nodes = [
      node('C', undefined, {
        dependsOn: [
          { from: 'A', condition: 'on_success' },
          { from: 'B', condition: 'on_failure' },
        ],
      }),
    ];
    const results = new Map<string, WorkflowNodeResult>();
    results.set('A', {
      nodeId: 'A', status: 'completed', answer: 'ok',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });
    results.set('B', {
      nodeId: 'B', status: 'failed', answer: '', error: 'fail',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });

    const { proceed, skipped } = resolveConditionalEdges(nodes, results);
    assert.equal(proceed.length, 1);
    assert.equal(skipped.length, 0);
  });

  it('transitive skip: skipped upstream propagates', () => {
    // B depends on A (on_success), A was skipped → B also skipped
    const nodes = [
      node('B', undefined, { dependsOn: [{ from: 'A', condition: 'on_success' }] }),
    ];
    const results = new Map<string, WorkflowNodeResult>();
    results.set('A', {
      nodeId: 'A', status: 'skipped', answer: '', skipReason: 'upstream failed',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });

    const { proceed, skipped } = resolveConditionalEdges(nodes, results);
    assert.equal(proceed.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.node.id, 'B');
    assert.ok(skipped[0]!.reason.includes('was skipped'));
    assert.ok(skipped[0]!.reason.includes('upstream failed'));
  });

  it('default condition is always', () => {
    const nodes = [
      node('B', undefined, { dependsOn: [{ from: 'A' }] }),
    ];
    const results = new Map<string, WorkflowNodeResult>();
    results.set('A', {
      nodeId: 'A', status: 'failed', answer: '', error: 'boom',
      startedAt: new Date(), completedAt: new Date(), retriesConsumed: 0,
    });

    const { proceed, skipped } = resolveConditionalEdges(nodes, results);
    // No condition specified → defaults to 'always' → proceeds
    assert.equal(proceed.length, 1);
    assert.equal(skipped.length, 0);
  });
});

// ─── WorkflowEngine.run() ─────────────────────────────────────────────────

describe('WorkflowEngine.run()', () => {
  it('full successful diamond workflow yields correct event sequence', async () => {
    const workflow = def('diamond', [
      node('A'),
      node('B', undefined, { dependsOn: [{ from: 'A' }] }),
      node('C', undefined, { dependsOn: [{ from: 'A' }] }),
      node('D', undefined, {
        dependsOn: [{ from: 'B' }, { from: 'C' }],
      }),
    ]);
    const engine = new WorkflowEngine(workflow, mockFactory());
    const events = [];
    for await (const event of engine.run()) {
      events.push(event);
    }

    // Events are yielded per-level: all starts, then all completes.
    // Level 0: [A] → node_start A, node_complete A
    // Level 1: [B, C] → node_start B, node_start C, node_complete B, node_complete C
    // Level 2: [D] → node_start D, node_complete D
    // Then: workflow_complete
    const types = events.map((e) => e.type);
    assert.deepStrictEqual(types, [
      'workflow_start',
      'node_start',        // A (level 0)
      'node_complete',     // A done
      'node_start',        // B (level 1)
      'node_start',        // C (level 1)
      'node_complete',     // B done
      'node_complete',     // C done
      'node_start',        // D (level 2)
      'node_complete',     // D done
      'workflow_complete',
    ]);
  });

  it('diamond workflow — verify level ordering', async () => {
    const executionOrder: string[] = [];
    const factory: ChatEngineFactory = ({ node: n }) => ({
      submitMessage: async () => {
        executionOrder.push(n.id);
        return {
          status: 'completed' as const,
          answer: `done ${n.id}`,
          usage: { totalCostUSD: 0, totalTokens: 10, totalInputTokens: 5, totalOutputTokens: 5 },
          conversation: [],
        };
      },
      cancel: () => {},
      getConversation: () => [],
      clearSystemPromptCache: () => {},
    } as any);

    const workflow = def('diamond', [
      node('A'),
      node('B', undefined, { dependsOn: [{ from: 'A' }] }),
      node('C', undefined, { dependsOn: [{ from: 'A' }] }),
      node('D', undefined, {
        dependsOn: [{ from: 'B' }, { from: 'C' }],
      }),
    ]);
    const engine = new WorkflowEngine(workflow, factory);
    const events = [];
    for await (const event of engine.run()) {
      events.push(event);
    }

    // A must execute before B and C; B and C before D
    const aIdx = executionOrder.indexOf('A');
    const bIdx = executionOrder.indexOf('B');
    const cIdx = executionOrder.indexOf('C');
    const dIdx = executionOrder.indexOf('D');

    assert.ok(aIdx < bIdx, 'A must execute before B');
    assert.ok(aIdx < cIdx, 'A must execute before C');
    assert.ok(bIdx < dIdx, 'B must execute before D');
    assert.ok(cIdx < dIdx, 'C must execute before D');

    // Verify all nodes completed
    const completeEvent = events.find((e) => e.type === 'workflow_complete');
    assert.ok(completeEvent);
    assert.equal(completeEvent.status, 'completed');
  });

  it('on_failure edge: failed node triggers recovery path', async () => {
    // A fails, B (on_success) skipped, C (on_failure) runs
    const failures = new Set<string>(['A']);
    const factory = mockFactoryWithFailures(failures);

    const workflow = def('recovery', [
      node('A'),
      node('B', undefined, { dependsOn: [{ from: 'A', condition: 'on_success' }] }),
      node('C', undefined, { dependsOn: [{ from: 'A', condition: 'on_failure' }] }),
    ]);

    const engine = new WorkflowEngine(workflow, factory);
    const events = [];
    for await (const event of engine.run()) {
      events.push(event);
    }

    // A should fail
    const aFailed = events.find((e) => e.type === 'node_failed' && e.nodeId === 'A');
    assert.ok(aFailed, 'A should have failed');

    // B should be skipped (on_success, but A failed)
    const bSkipped = events.find((e) => e.type === 'node_skipped' && e.nodeId === 'B');
    assert.ok(bSkipped, 'B should be skipped');

    // C should complete (on_failure, A failed → C runs)
    const cComplete = events.find((e) => e.type === 'node_complete' && e.nodeId === 'C');
    assert.ok(cComplete, 'C should run (recovery path)');

    // Workflow is 'partial': A failed, B skipped, C completed (recovery ran but not all succeeded)
    const wfComplete = events.find((e) => e.type === 'workflow_complete');
    assert.ok(wfComplete);
    assert.equal(wfComplete.status, 'partial');
  });

  it('retry: node succeeds on second attempt', async () => {
    let attempts = 0;
    const factory: ChatEngineFactory = ({ node: n }) => ({
      submitMessage: async () => {
        attempts++;
        if (attempts < 2) {
          return {
            status: 'failed' as const,
            answer: `Attempt ${attempts} failed`,
            usage: { totalCostUSD: 0, totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 },
            conversation: [],
          };
        }
        return {
          status: 'completed' as const,
          answer: `Success on attempt ${attempts}`,
          usage: { totalCostUSD: 0.01, totalTokens: 100, totalInputTokens: 50, totalOutputTokens: 50 },
          conversation: [],
        };
      },
      cancel: () => {},
      getConversation: () => [],
      clearSystemPromptCache: () => {},
    } as any);

    const workflow = def('retry-test', [
      node('A', undefined, { maxRetries: 2 }),
    ]);
    const engine = new WorkflowEngine(workflow, factory);
    const events = [];
    for await (const event of engine.run()) {
      events.push(event);
    }

    // Should have a retry event
    const retryEvent = events.find((e) => e.type === 'node_retry');
    assert.ok(retryEvent, 'Should have a retry event');
    assert.equal(retryEvent.attempt, 1);

    // Should complete successfully
    const completeEvent = events.find((e) => e.type === 'node_complete' && e.nodeId === 'A');
    assert.ok(completeEvent, 'Should complete after retry');
  });

  it('retry exhaust: node fails all attempts', async () => {
    const factory: ChatEngineFactory = () => ({
      submitMessage: async () => ({
        status: 'failed' as const,
        answer: 'Always fails',
        usage: { totalCostUSD: 0, totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 },
        conversation: [],
      }),
      cancel: () => {},
      getConversation: () => [],
      clearSystemPromptCache: () => {},
    } as any);

    const workflow = def('exhaust-test', [
      node('A', undefined, { maxRetries: 2 }),
    ]);
    const engine = new WorkflowEngine(workflow, factory);
    const events = [];
    for await (const event of engine.run()) {
      events.push(event);
    }

    // Should have 2 retry events (attempt 1 and 2)
    const retryEvents = events.filter((e) => e.type === 'node_retry');
    assert.equal(retryEvents.length, 2);

    // Should fail
    const failEvent = events.find((e) => e.type === 'node_failed' && e.nodeId === 'A');
    assert.ok(failEvent);
    if (failEvent && failEvent.type === 'node_failed') {
      assert.equal(failEvent.retriesExhausted, true);
    }

    // Workflow should be 'failed'
    const wfComplete = events.find((e) => e.type === 'workflow_complete');
    assert.ok(wfComplete);
    assert.equal(wfComplete.status, 'failed');
  });

  it('cancel mid-execution skips remaining nodes', async () => {
    // Create a factory where A hangs, giving us time to cancel
    let resolveA: (() => void) | null = null;
    const aStarted = new Promise<void>((resolve) => { resolveA = resolve; });

    const factory: ChatEngineFactory = ({ node: n }) => {
      if (n.id === 'A') {
        return {
          submitMessage: async () => {
            resolveA?.();
            // Hang until cancelled
            // Intentionally never-resolving promise — no timer leak
            await new Promise(() => {});
            return { status: 'completed', answer: '', usage: undefined, conversation: [] };
          },
          cancel: () => {},
          getConversation: () => [],
          clearSystemPromptCache: () => {},
        } as any;
      }
      return mockFactory()({ node: n, projectRoot: '' });
    };

    const workflow = def('cancel-test', [
      node('A', undefined, { timeoutMs: 5000 }), // will time out
      node('B', undefined, { dependsOn: [{ from: 'A' }] }),
    ]);
    const engine = new WorkflowEngine(workflow, factory);

    const events: any[] = [];
    const runPromise = (async () => {
      for await (const event of engine.run()) {
        events.push(event);
      }
    })();

    // Wait for A to start then cancel
    await aStarted;
    await new Promise((r) => setTimeout(r, 100));
    engine.cancel();

    await runPromise.catch(() => {});

    // B should NOT have started (was in next level after A)
    const bStarted = events.find((e) => e.type === 'node_start' && e.nodeId === 'B');
    assert.ok(!bStarted, 'B should not have started after cancel');
  });

  it('concurrency: respects concurrency limit', async () => {
    const inFlight = new Set<string>();
    let maxConcurrent = 0;

    const factory: ChatEngineFactory = ({ node: n }) => ({
      submitMessage: async () => {
        inFlight.add(n.id);
        maxConcurrent = Math.max(maxConcurrent, inFlight.size);
        // Small delay to ensure overlap
        await new Promise((r) => setTimeout(r, 20));
        inFlight.delete(n.id);
        return {
          status: 'completed' as const,
          answer: `done ${n.id}`,
          usage: { totalCostUSD: 0, totalTokens: 10, totalInputTokens: 5, totalOutputTokens: 5 },
          conversation: [],
        };
      },
      cancel: () => {},
      getConversation: () => [],
      clearSystemPromptCache: () => {},
    } as any);

    // 6 root nodes, concurrency: 2
    const nodes = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => node(id));
    const workflow = def('concurrency-test', nodes, { concurrency: 2 });
    const engine = new WorkflowEngine(workflow, factory);
    const events = [];
    for await (const event of engine.run()) {
      events.push(event);
    }

    // With concurrency 2, max concurrent should be ≤ 2
    assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected ≤ 2`);

    // All 6 should complete
    const completeEvents = events.filter((e) => e.type === 'node_complete');
    assert.equal(completeEvents.length, 6);
  });

  it('empty nodes throws', () => {
    assert.throws(
      () => new WorkflowEngine(def('empty', []), mockFactory()),
      /at least one node/,
    );
  });
});

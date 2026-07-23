/**
 * Structured event emitter for agent harness observability.
 *
 * Lightweight typed event bus — no framework dependency, follows the same
 * module-level handler pattern as pipeline.ts BabelEventBus without depending
 * on it. Testable: call setAgentEventHandler(null) to disable emission.
 */

import type { PermissionDecision, PermissionPreset } from './policy.js';

// ── Event types ──────────────────────────────────────────────────────────

export type AgentEvent =
  | {
      type: 'policy_decision';
      action: string;
      decision: PermissionDecision;
      preset: PermissionPreset;
      rule?: string;
      runId?: string;
      agentId?: string;
    }
  | {
      type: 'scope_violation';
      action: string;
      target: string;
      projectRoot: string;
      preset: PermissionPreset;
    }
  | { type: 'malformed_config'; source: string; detail: string; severity: 'warn' | 'error' }
  | { type: 'tool_timeout'; action: string; tool: string; timeoutMs: number }
  | { type: 'circuit_breaker'; reason: string; consecutiveBlocks: number };

// ── Emitter ──────────────────────────────────────────────────────────────

export type AgentEventHandler = (event: AgentEvent) => void;

let handler: AgentEventHandler | null = null;

export function setAgentEventHandler(h: AgentEventHandler | null): void {
  handler = h;
}

export function emitAgentEvent(event: AgentEvent): void {
  if (handler) {
    try {
      handler(event);
    } catch {
      // Silently drop handler errors — never let observability break execution.
    }
  }
}

// Default handler: restore console.warn for malformed_config events.
// Callers can override with setAgentEventHandler() for richer telemetry.
setAgentEventHandler((event) => {
  if (event.type === 'malformed_config') {
    console.warn(`[babel:${event.source}] ${event.detail}`);
  }
});

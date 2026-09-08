/** Exact-action tool retries only: excludes provider retries and differently phrased actions. */
export class RecoveryObservation {
  private readonly calls = new Map<string, { key: string; action: string; retry: boolean; completed: boolean }>();
  private readonly pending = new Set<string>();
  private readonly failures: Array<{ category: string; diagnostic: string; action: string; key: string; visible: boolean }> = [];
  private retryCount = 0;
  private recovered = false;

  start(id: string, tool: string, target: string): void {
    if (this.calls.has(id)) return;
    const key = JSON.stringify([tool, target]);
    const retry = this.pending.has(key);
    if (retry) this.retryCount += 1;
    this.calls.set(id, { key, action: `${tool}: ${target}`, retry, completed: false });
  }

  complete(id: string, success: boolean | 'UNKNOWN', diagnostic = 'UNKNOWN'): void {
    const call = this.calls.get(id);
    if (!call || call.completed) return;
    call.completed = true;
    if (success === false) {
      this.pending.add(call.key);
      this.failures.push({ category: 'TOOL_FAILURE', diagnostic, action: call.action, key: call.key, visible: false });
    } else if (success === true && call.retry) {
      this.pending.delete(call.key);
      this.recovered = true;
    }
  }

  /** Correlated provider input must preserve the complete recorded diagnostic. */
  modelFacing(tool: string, target: string, diagnostic: string): void {
    const key = JSON.stringify([tool, target]);
    for (const failure of this.failures) {
      if (failure.key === key && failure.diagnostic !== 'UNKNOWN' && failure.diagnostic.trim().length > 0 && diagnostic.includes(failure.diagnostic)) {
        failure.visible = true;
      }
    }
  }

  snapshot(): {
    failures: Array<{ category: string; diagnostic: string; action: string }>;
    retries: number | 'UNKNOWN'; recoverySuccess: boolean | 'UNKNOWN'; actionableDiagnostics: boolean | 'UNKNOWN';
  } {
    return {
      failures: this.failures.map(({ category, diagnostic, action }) => ({ category, diagnostic, action })),
      retries: this.calls.size ? this.retryCount : 'UNKNOWN',
      recoverySuccess: this.failures.length ? this.recovered && this.pending.size === 0 : 'UNKNOWN',
      // This measures retention of known diagnostic detail, not whether the model understood it.
      actionableDiagnostics: this.failures.length && this.failures.every((failure) => failure.visible) ? true : 'UNKNOWN',
    };
  }
}

/** Canonical serialization avoids treating object key order as a different tool action. */
export function exactAction(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(exactAction).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${exactAction(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'UNKNOWN';
}

/** Read Claude stream tool IDs; only a subsequent assistant turn confirms diagnostic visibility. */
export function observeClaudeRecovery(messages: readonly Record<string, unknown>[]): ReturnType<RecoveryObservation['snapshot']> {
  const observation = new RecoveryObservation();
  const calls = new Map<string, { tool: string; target: string }>();
  const pendingDiagnostics: Array<{ tool: string; target: string; diagnostic: string }> = [];
  for (const message of messages) {
    if (message['type'] === 'assistant') {
      for (const item of pendingDiagnostics.splice(0)) observation.modelFacing(item.tool, item.target, item.diagnostic);
    }
    const nested = message['message'];
    const content = nested && typeof nested === 'object' ? (nested as Record<string, unknown>)['content'] : message['content'];
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      if (block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
        const call = { tool: block['name'], target: exactAction(block['input']) };
        calls.set(block['id'], call);
        observation.start(block['id'], call.tool, call.target);
      } else if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        const diagnostic = typeof block['content'] === 'string' ? block['content'] : exactAction(block['content']);
        observation.complete(block['tool_use_id'], block['is_error'] === true ? false : block['is_error'] === false || block['is_error'] === undefined ? true : 'UNKNOWN', diagnostic);
        const call = calls.get(block['tool_use_id']);
        if (call && block['is_error'] === true) pendingDiagnostics.push({ ...call, diagnostic });
      }
    }
  }
  return observation.snapshot();
}

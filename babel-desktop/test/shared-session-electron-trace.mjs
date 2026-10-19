/** Parse stderr lines emitted when BABEL_TEST_SHARED_SESSION_TRACE=1. */
export function parseSharedSessionTrace(buffer) {
  const stages = [];
  for (const line of String(buffer).split('\n')) {
    const marker = '[shared-session-trace] ';
    const index = line.indexOf(marker);
    if (index < 0) continue;
    try {
      stages.push(JSON.parse(line.slice(index + marker.length)));
    } catch {
      /* ignore */
    }
  }
  return stages;
}

export function waitForTraceStage(stages, stage, { timeoutMs = 15_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (stages.some((entry) => entry.stage === stage)) {
        resolve(stages.filter((entry) => entry.stage === stage));
        return;
      }
      if (Date.now() >= deadline) {
        reject(
          new Error(
            `Timed out waiting for trace stage "${stage}"; saw: ${JSON.stringify(stages.map((s) => s.stage))}`,
          ),
        );
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

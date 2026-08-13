import { dim, error } from "./theme.js";

export interface SubAgentOverlayEntry {
  label: string;
  startTime: number;
  status: "running" | "complete" | "failed";
  tokens?: number;
  error?: string;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function renderSubAgentOverlay(
  agents: ReadonlyMap<string, SubAgentOverlayEntry>,
  spinner: string,
  now = Date.now(),
): string[] {
  const all = Array.from(agents.entries());
  if (all.length === 0) return [];
  const rank = (status: SubAgentOverlayEntry["status"]): number =>
    status === "running" ? 0 : status === "failed" ? 1 : 2;
  all.sort(
    (a, b) =>
      rank(a[1].status) - rank(b[1].status) || a[1].startTime - b[1].startTime,
  );

  const maxVisible = 5;
  const lines = all.slice(0, maxVisible).map(([, agent], index, visible) => {
    const branch =
      index === visible.length - 1 && all.length <= maxVisible ? "└─" : "├─";
    const elapsed = formatElapsed(now - agent.startTime);
    if (agent.status === "running") {
      return `  ${dim(branch)} ${spinner} ${agent.label} ${dim(`(${elapsed})`)}`;
    }
    if (agent.status === "failed") {
      const detail = agent.error ? ` ${dim(agent.error)}` : "";
      return `  ${dim(branch)} ${error(`✗ ${agent.label}`)}${detail} ${dim(`(${elapsed})`)}`;
    }
    const tokens = agent.tokens
      ? ` ${dim(`(${agent.tokens.toLocaleString()} tokens)`)}`
      : "";
    return `  ${dim(branch)} ${dim(`✓ ${agent.label} (${elapsed})`)}${tokens}`;
  });
  if (all.length > maxVisible) {
    lines.push(`  ${dim("└─")} ${dim(`(+${all.length - maxVisible} more)`)}`);
  }
  return lines;
}

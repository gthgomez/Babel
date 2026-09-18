import {
  border,
  getEffectiveTerminalWidth,
  muted,
  sectionLabel,
  visibleLength,
} from "./theme.js";

export function renderSectionHeader(label: string, metadata = ""): string {
  const title = sectionLabel(`▌ ${String(label).trim().toUpperCase()}`);
  const meta = metadata ? muted(` · ${metadata}`) : "";
  const width = getEffectiveTerminalWidth();
  const ruleWidth = Math.max(
    0,
    width - visibleLength(title) - visibleLength(meta) - 4,
  );
  return `${title}${meta} ${border("─".repeat(ruleWidth))}`;
}

export function renderSection(
  label: string,
  bodyLines: string | string[],
  metadata = "",
): string {
  const lines = Array.isArray(bodyLines) ? bodyLines : [bodyLines];
  return [renderSectionHeader(label, metadata), ...lines].join("\n");
}

/**
 * Knowledge-graph renderers — stateless, function-based ANSI string formatters.
 *
 * All three renderers follow the function-based rendering paradigm (ADR-009):
 * pure data-in, ANSI-string-out. No Component subclass, no streaming,
 * no FrameScheduler. Consumed by the kg_* tool handlers and the chat UI.
 *
 * @module kgRenderers
 */

import { renderHorizontalBar } from './usageCharts.js';
import {
  bold,
  dim,
  muted,
  primary,
  accent,
  success,
  warning,
  error,
  info,
  sectionLabel,
  truncate,
  visibleLength,
  renderRule,
} from './theme.js';

import type { CallPathEdge, ImpactHop, ArchitectureStats } from '../services/codeGraphBackend.js';

// ── Unicode drawing characters ─────────────────────────────────────────────

const TEE = '├──';
const ELBOW = '└──';
const PIPE = '│  ';
const BLANK = '   ';

// ── renderCallPathTree ─────────────────────────────────────────────────────

/**
 * Render a call path as an indented ASCII tree.
 *
 * Uses box-drawing characters (├── / └── / │) and color-codes edges by depth:
 *   - depth 0 = bold / primary (nearest neighbors)
 *   - depth 1+ = muted (further away)
 *   - highlight symbol = accent
 *
 * @param edges - Call path edges from CodeGraphBackend.tracePath()
 * @param width - Available terminal width for truncation
 * @param highlightSymbol - Optional symbol name to highlight in accent color
 * @returns ANSI-formatted string (no trailing newline)
 */
export function renderCallPathTree(
  edges: CallPathEdge[],
  width: number,
  highlightSymbol?: string,
): string {
  if (edges.length === 0) return muted('  (no call paths found)');

  // Build adjacency: parent → children
  const children = new Map<string, CallPathEdge[]>();
  const roots: CallPathEdge[] = [];

  for (const edge of edges) {
    const existing = children.get(edge.from);
    if (existing) {
      existing.push(edge);
    } else {
      children.set(edge.from, [edge]);
    }
  }

  // Find root edges (from symbols that are not the 'to' of any other edge)
  const toSymbols = new Set(edges.map((e) => e.to));
  for (const edge of edges) {
    if (!toSymbols.has(edge.from)) {
      roots.push(edge);
    }
  }

  // If every symbol is both from and to (circular), just use all edges
  const startEdges = roots.length > 0 ? roots : edges;
  const visited = new Set<string>();
  const lines: string[] = [];

  function walk(edgeList: CallPathEdge[], prefix: string, depth: number): void {
    for (let i = 0; i < edgeList.length; i++) {
      const edge = edgeList[i]!;
      const isLast = i === edgeList.length - 1;
      const connector = isLast ? ELBOW : TEE;
      const continuation = isLast ? BLANK : PIPE;

      // Determine color based on depth
      const depthColor = depth === 0 ? bold : muted;
      const toName =
        highlightSymbol && edge.to === highlightSymbol
          ? accent(edge.to)
          : depthColor(edge.to);

      // Build the line
      const fileLoc = dim(`  ${edge.toFile}:${edge.toLine}`);
      const relInfo = edge.relationship ? muted(` [${edge.relationship}]`) : '';
      const line = `${prefix}${connector} ${toName}${relInfo}${fileLoc}`;

      lines.push(truncate(line, width));

      // Recurse into children of this edge's 'to' symbol
      const edgeKey = edge.to;
      if (!visited.has(edgeKey)) {
        visited.add(edgeKey);
        const childEdges = children.get(edge.to);
        if (childEdges && childEdges.length > 0) {
          walk(childEdges, prefix + continuation, depth + 1);
        }
      }
    }
  }

  // Render root line
  if (startEdges.length > 0) {
    const rootSymbol = startEdges[0]!.from;
    lines.push(bold(rootSymbol));
    visited.add(rootSymbol);
  }

  walk(startEdges, '', 0);

  return lines.join('\n');
}

// ── renderImpactPanel ──────────────────────────────────────────────────────

/**
 * Render an impact analysis report with risk-classified sections.
 *
 * Groups hops by risk level and renders each as a colored section:
 *   - HIGH = error() red
 *   - MEDIUM = warning() yellow
 *   - LOW = muted() dim
 *
 * @param hops - Impact hops from CodeGraphBackend.impactAnalysis()
 * @param width - Available terminal width
 * @returns ANSI-formatted string
 */
export function renderImpactPanel(hops: ImpactHop[], width: number): string {
  if (hops.length === 0) return muted('  (no impact detected)');

  const byRisk = {
    high: hops.filter((h) => h.risk === 'high'),
    medium: hops.filter((h) => h.risk === 'medium'),
    low: hops.filter((h) => h.risk === 'low'),
  };

  const total = hops.length;
  const summaryLine = `${total} affected · ${byRisk.high.length} HIGH · ${byRisk.medium.length} MEDIUM · ${byRisk.low.length} LOW`;

  const lines: string[] = [];
  lines.push('');
  lines.push(sectionLabel('IMPACT ANALYSIS'));
  lines.push(muted(`  ${summaryLine}`));
  lines.push(muted(`  ${renderRule(Math.min(width - 2, 48))}`));

  for (const riskLevel of ['high', 'medium', 'low'] as const) {
    const group = byRisk[riskLevel];
    if (group.length === 0) continue;

    const colorFn = riskLevel === 'high' ? error : riskLevel === 'medium' ? warning : muted;
    const label = riskLevel.toUpperCase();
    lines.push('');
    lines.push(`  ${colorFn(`${label} RISK`)} ${muted(`(${group.length})`)}`);

    for (const hop of group) {
      const fileLoc = dim(`${hop.file}:${hop.line}`);
      lines.push(`    ${primary(hop.symbol)}  ${fileLoc}`);

      if (hop.callers.length > 0) {
        const callerList = hop.callers.slice(0, 5).join(', ');
        const more = hop.callers.length > 5 ? dim(` +${hop.callers.length - 5} more`) : '';
        lines.push(`      ${muted('callers:')} ${muted(callerList)}${more}`);
      }

      if (hop.callees.length > 0) {
        const calleeList = hop.callees.slice(0, 5).join(', ');
        const more = hop.callees.length > 5 ? dim(` +${hop.callees.length - 5} more`) : '';
        lines.push(`      ${muted('callees:')} ${muted(calleeList)}${more}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── renderArchitectureDashboard ────────────────────────────────────────────

/**
 * Render a multi-section architecture dashboard.
 *
 * Sections:
 *   1. Language breakdown with horizontal bars (via renderHorizontalBar)
 *   2. Hotspot list (most complex symbols, color-coded by threshold)
 *   3. Package map (top packages by symbol count)
 *
 * @param stats - Architecture stats from CodeGraphBackend.getArchitecture()
 * @param width - Available terminal width
 * @returns ANSI-formatted string
 */
export function renderArchitectureDashboard(stats: ArchitectureStats, width: number): string {
  const lines: string[] = [];
  const barWidth = Math.max(10, Math.min(30, Math.floor(width * 0.35)));

  lines.push('');
  lines.push(sectionLabel('ARCHITECTURE OVERVIEW'));
  lines.push(
    muted(
      `  ${stats.totalSymbols.toLocaleString()} symbols in ${stats.totalFiles.toLocaleString()} files`,
    ),
  );

  // ── Languages ──────────────────────────────────────────────────────────

  const langEntries = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]);
  if (langEntries.length > 0) {
    lines.push('');
    lines.push(`  ${bold('Languages')}`);
    const maxLang = langEntries[0]![1] || 1;
    for (const [lang, count] of langEntries.slice(0, 8)) {
      const pct = maxLang > 0 ? Math.round((count / stats.totalSymbols) * 100) : 0;
      const bar = renderHorizontalBar(count, maxLang, barWidth, lang);
      const pctStr = muted(`${String(pct).padStart(3)}%`);
      lines.push(`${bar}  ${pctStr}`);
    }
    if (langEntries.length > 8) {
      lines.push(muted(`    +${langEntries.length - 8} more languages`));
    }
  }

  // ── Hotspots ───────────────────────────────────────────────────────────

  const topHotspots = stats.hotspots.slice(0, 10);
  if (topHotspots.length > 0) {
    lines.push('');
    lines.push(`  ${bold('Hotspots')} ${muted('(most complex)')}`);
    for (const h of topHotspots) {
      const complexityColor =
        h.complexity > 30 ? error : h.complexity > 15 ? warning : muted;
      const complexityLabel = complexityColor(
        `complexity ${h.complexity}`,
      );
      const symbol = primary(h.symbol);
      const fileLoc = dim(`  ${h.file}:${h.line}`);
      lines.push(`    ${symbol}${fileLoc}`);
      lines.push(`      ${complexityLabel}`);
    }
  }

  // ── Packages ───────────────────────────────────────────────────────────

  const topPackages = stats.packages.slice(0, 10);
  if (topPackages.length > 0) {
    lines.push('');
    lines.push(`  ${bold('Top Packages')}`);
    const maxPkg = topPackages[0]?.symbolCount ?? 1;
    for (const pkg of topPackages) {
      const count = pkg.symbolCount;
      const barWidth_pkg = Math.floor((count / Math.max(1, maxPkg)) * barWidth);
      const bar = info('█'.repeat(Math.max(0, barWidth_pkg)) + '░'.repeat(Math.max(0, barWidth - barWidth_pkg)));
      const label = muted(pkg.name.padEnd(40).slice(0, 40));
      const countStr = primary(String(count));
      lines.push(`    ${label} ${bar} ${countStr}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

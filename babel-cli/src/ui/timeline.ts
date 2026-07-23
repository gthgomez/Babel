import { PIPELINE_STAGES, STAGE_STATE_SYMBOLS } from './tokens.js';
import { renderBadge } from './badges.js';
import {
  accentBright,
  colorToken,
  getTerminalWidth,
  muted,
  primary,
  formatOverflow,
  visibleLength,
} from './theme.js';
import { renderSection } from './sections.js';

export type StageState = 'PASS' | 'ACTIVE' | 'PENDING' | 'FAIL' | 'BLOCKED';

export interface StageDescriptor {
  index: number;
  label: string;
  state: StageState;
  meta?: string;
}

function normalizeStageState(state: string): StageState {
  const normalized = String(state ?? 'PENDING')
    .trim()
    .toUpperCase();
  if (normalized === 'REJECT') return 'FAIL';
  return (['PASS', 'ACTIVE', 'PENDING', 'FAIL', 'BLOCKED'] as const).includes(
    normalized as StageState,
  )
    ? (normalized as StageState)
    : 'PENDING';
}

function toneForStageState(state: StageState): string {
  switch (state) {
    case 'PASS':
      return 'success';
    case 'ACTIVE':
      return 'accentGoldBright';
    case 'FAIL':
      return 'error';
    case 'BLOCKED':
      return 'warning';
    default:
      return 'textMuted';
  }
}

export function buildStageDescriptors(
  states: string[],
  labels: string[] = PIPELINE_STAGES,
): StageDescriptor[] {
  return labels.map((label, index) => ({
    index: index + 1,
    label,
    state: normalizeStageState(states[index] ?? 'PENDING'),
  }));
}

export interface TimelineOptions {
  indent?: string;
  overflow?: string;
}

export function renderStageTimeline(
  stageDescriptors: StageDescriptor[],
  options: TimelineOptions = {},
): string {
  const width = getTerminalWidth();
  const indent = options.indent ?? '  ';
  const overflow = options.overflow ?? 'truncate';
  const lines: string[] = [];

  for (let index = 0; index < stageDescriptors.length; index++) {
    const stage = stageDescriptors[index]!;
    const state = normalizeStageState(stage.state);
    const symbol = colorToken(toneForStageState(state), STAGE_STATE_SYMBOLS[state]!, {
      bold: true,
    });
    const labelText = state === 'ACTIVE' ? accentBright(stage.label) : primary(stage.label);
    const prefix = `${indent}${symbol} ${String(stage.index).padStart(2, '0')}  ${labelText}  ${renderBadge(state)}`;
    const prefixWidth = visibleLength(prefix);
    const metaLines = stage.meta
      ? formatOverflow(String(stage.meta), Math.max(12, width - prefixWidth - 2), overflow)
      : [];

    lines.push(metaLines.length > 0 ? `${prefix}  ${muted(metaLines[0]!)}` : prefix);

    for (let metaIndex = 1; metaIndex < metaLines.length; metaIndex++) {
      lines.push(`${indent}${muted(' '.repeat(6))}  ${muted(metaLines[metaIndex]!)}`);
    }

    if (index < stageDescriptors.length - 1) {
      lines.push(`${indent}${muted('│')}`);
    }
  }

  return lines.join('\n');
}

export interface StageSectionOptions {
  failedStage?: number;
  blockedStage?: number;
  activeState?: StageState;
  labels?: string[];
  stageMeta?: Record<number, string>;
  sectionLabel?: string;
  metadata?: string;
  overflow?: string;
}

export function renderStageSection(activeIndex: number, options: StageSectionOptions = {}): string {
  const states = [1, 2, 3, 4].map((stageIndex) => {
    if (options.failedStage === stageIndex) return 'FAIL' as const;
    if (options.blockedStage === stageIndex) return 'BLOCKED' as const;
    if (stageIndex < activeIndex) return 'PASS' as const;
    if (stageIndex === activeIndex) return (options.activeState ?? 'ACTIVE') as StageState;
    return 'PENDING' as const;
  });

  const stages = buildStageDescriptors(
    states,
    options.labels ?? ['Analyze', 'Plan', 'Review', 'Apply'],
  ).map((stage) => ({
    ...stage,
    ...(options.stageMeta?.[stage.index] ? { meta: options.stageMeta[stage.index] } : {}),
  }));

  return renderSection(
    options.sectionLabel ?? 'PIPELINE',
    [renderStageTimeline(stages, { overflow: options.overflow ?? 'truncate' })],
    options.metadata ?? 'layered execution',
  );
}

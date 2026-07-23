/**
 * Multi-agent progress tracking components for Babel's TUI.
 *
 * Provides real-time visibility into parallel agent execution:
 *   - AgentProgressPane: single agent's status, task, spinner, cost
 *   - AgentTeamOverview: matrix of all agents with aggregate stats
 *
 * Uses Component base class, Box/Text/Stack primitives, and
 * FrameScheduler for live spinner/cost updates.
 *
 * Usage:
 *   const team = new AgentTeamOverview();
 *   team.addAgent({ id: 'researcher', name: 'Research', task: 'Find bugs' });
 *   team.setAgentStatus('researcher', 'active');
 *   // ... later
 *   team.setAgentStatus('researcher', 'complete', { cost: 0.0234 });
 *   const output = team.render();
 *
 * @module agentProgress
 */

import { Component } from './component.js';
import { Box, Text, Stack, Spacer } from './primitives.js';
import {
  dim,
  muted,
  ghost,
  accent,
  bold,
  primary,
  success,
  warning,
  error,
  info,
  bgPanel,
  bgAccent,
  getEffectiveTerminalWidth,
  visibleLength,
  truncate,
} from './theme.js';
import type { KeyEvent } from './keyInput.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AgentStatus = 'pending' | 'active' | 'blocked' | 'complete' | 'error';

export interface AgentInfo {
  /** Unique agent identifier */
  id: string;
  /** Display name (e.g. "Researcher", "Implementer") */
  name: string;
  /** Current task description */
  task: string;
  /** Current status */
  status?: AgentStatus;
  /** Accumulated cost in dollars */
  cost?: number;
  /** Number of steps/turns executed */
  steps?: number;
  /** When the agent started (ms timestamp) */
  startedAt?: number;
  /** Optional sub-label (e.g. model name or tool category) */
  sublabel?: string;
}

// ─── Spinner ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const SPINNER_INTERVAL_MS = 200;

// ─── AgentProgressPane ──────────────────────────────────────────────────────

export class AgentProgressPane extends Component {
  private info: AgentInfo;
  private spinnerFrame = 0;

  constructor(info: AgentInfo) {
    super();
    this.info = { ...info };
  }

  update(info: Partial<AgentInfo>): void {
    Object.assign(this.info, info);
    this.markDirty();
  }

  /** Advance spinner frame. Returns true if visible change occurred. */
  tick(): boolean {
    if (this.info.status !== 'active') return false;
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    return true;
  }

  override handleKey(_event: KeyEvent): boolean {
    return false;
  }

  override render(): string {
    const { name, task, status, cost, steps, sublabel } = this.info;
    const width = Math.min(getEffectiveTerminalWidth() - 4, 60);

    // Status indicator
    const indicator = this.statusIndicator(status ?? 'pending');

    // Agent name + optional sublabel
    const nameLine = sublabel ? `${bold(name)} ${dim(`(${sublabel})`)}` : bold(name);

    // Task description (truncated)
    const taskDisplay = truncate(task, width - 8);

    // Stats line: cost + steps
    const parts: string[] = [];
    if (cost !== undefined && cost > 0) {
      parts.push(dim(`$${cost.toFixed(4)}`));
    }
    if (steps !== undefined && steps > 0) {
      parts.push(muted(`${steps} steps`));
    }
    const statsLine = parts.length > 0 ? `  ${parts.join(' · ')}` : '';

    // Build content
    const lines: string[] = [];
    lines.push(`${indicator} ${nameLine}`);
    lines.push(`  ${dim(taskDisplay)}`);
    if (statsLine) lines.push(statsLine);

    return lines.join('\n');
  }

  private statusIndicator(status: AgentStatus): string {
    switch (status) {
      case 'active': {
        const frame = SPINNER_FRAMES[this.spinnerFrame] ?? '◐';
        return accent(frame);
      }
      case 'complete':
        return success('✓');
      case 'error':
        return error('✗');
      case 'blocked':
        return warning('⏸');
      default:
        return ghost('○');
    }
  }

  /** Render as a compact single-line summary for the team overview. */
  renderCompact(): string {
    const { name, status, cost } = this.info;
    const indicator = this.statusIndicator(status ?? 'pending');
    const costStr = cost !== undefined && cost > 0 ? ` ${dim(`$${cost.toFixed(3)}`)}` : '';
    return `${indicator} ${name}${costStr}`;
  }
}

// ─── AgentTeamOverview ──────────────────────────────────────────────────────

export class AgentTeamOverview extends Component {
  private agents: Map<string, AgentProgressPane> = new Map();
  private headerText = 'Agents';
  private collapsed = false;
  private _box: Box;

  constructor() {
    super();
    this._box = new Box({
      border: 'single',
      borderColor: 'border',
      padding: { top: 0, right: 1, bottom: 0, left: 1 },
      children: [''],
    });
  }

  /** Add or replace an agent in the overview. */
  addAgent(info: AgentInfo): AgentProgressPane {
    const pane = new AgentProgressPane(info);
    this.agents.set(info.id, pane);
    this.addChild(pane);
    this.markDirty();
    return pane;
  }

  /** Remove an agent from the overview. */
  removeAgent(id: string): void {
    const pane = this.agents.get(id);
    if (pane) {
      this.removeChild(pane);
      this.agents.delete(id);
      this.markDirty();
    }
  }

  /** Update an existing agent's info. */
  updateAgent(id: string, info: Partial<AgentInfo>): void {
    const pane = this.agents.get(id);
    if (pane) {
      pane.update(info);
      this.markDirty();
    }
  }

  /** Set agent status shorthand. */
  setAgentStatus(id: string, status: AgentStatus, extra?: Partial<AgentInfo>): void {
    this.updateAgent(id, { status, ...extra });
  }

  /** Get an agent pane by ID. */
  getAgent(id: string): AgentProgressPane | undefined {
    return this.agents.get(id);
  }

  /** Total number of agents tracked. */
  get agentCount(): number {
    return this.agents.size;
  }

  /** Advance all active agent spinners. */
  tickAll(): void {
    let changed = false;
    for (const agent of this.agents.values()) {
      if (agent.tick()) changed = true;
    }
    if (changed) this.markDirty();
  }

  /** Toggle collapsed mode (compact single-line per agent). */
  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.markDirty();
  }

  setHeader(text: string): void {
    this.headerText = text;
    this.markDirty();
  }

  override handleKey(_event: KeyEvent): boolean {
    return false;
  }

  override render(): string {
    if (this.agents.size === 0) return '';

    // Compute aggregate stats
    const statuses = [...this.agents.values()].map((a) => (a as any).info?.status ?? 'pending');
    const active = statuses.filter((s) => s === 'active').length;
    const complete = statuses.filter((s) => s === 'complete').length;
    const blocked = statuses.filter((s) => s === 'blocked').length;
    const failed = statuses.filter((s) => s === 'error').length;
    const pending = statuses.filter((s) => s === 'pending').length;
    const total = this.agents.size;

    // Build status bar
    const barParts: string[] = [];
    if (active > 0) barParts.push(accent(`${active} active`));
    if (complete > 0) barParts.push(success(`${complete} done`));
    if (blocked > 0) barParts.push(warning(`${blocked} blocked`));
    if (failed > 0) barParts.push(error(`${failed} failed`));
    if (pending > 0) barParts.push(ghost(`${pending} pending`));
    const statusBar = barParts.join(' · ');

    // Progress bar: ████░░░░░░
    const progressWidth = 20;
    const doneCount = complete + failed;
    const progressPct = total > 0 ? doneCount / total : 0;
    const filled = Math.round(progressWidth * progressPct);
    const progressBar = success('█'.repeat(filled)) + ghost('░'.repeat(progressWidth - filled));

    // Header
    const header = `${bold(this.headerText)}  ${dim(`(${total})`)}  ${progressBar}  ${progressPct > 0 ? dim(`${Math.round(progressPct * 100)}%`) : ''}`;

    const lines: string[] = [header, dim(statusBar), ''];

    // Agent panes
    if (this.collapsed) {
      // Compact mode: single line per agent
      for (const agent of this.agents.values()) {
        lines.push(`  ${agent.renderCompact()}`);
      }
    } else {
      // Full mode: multi-line per agent with separators
      let first = true;
      for (const agent of this.agents.values()) {
        if (!first) lines.push('');
        lines.push(agent.render());
        first = false;
      }
    }

    const content = lines.join('\n');

    // Update the cached Box's content and render -- avoids allocating
    // a new Box (and its child-registration overhead) on every frame.
    (this._box as any)._children = [content];
    return this._box.render();
  }
}

// ─── Multi-agent stream manager ─────────────────────────────────────────────

export interface AgentStreamEvent {
  agentId: string;
  type: 'chunk' | 'tool_start' | 'tool_complete' | 'status' | 'error';
  text?: string;
  tool?: string;
  target?: string;
  detail?: string;
}

/**
 * Manages parallel output streams from multiple agents.
 *
 * Provides interleaved output with agent-colored prefixes so the
 * user can distinguish which agent produced each line.
 */
export class AgentStreamManager {
  private streams: Map<string, AgentStreamEvent[]> = new Map();
  private agentColors: Map<string, (t: string) => string> = new Map();
  private colorPool: Array<(t: string) => string> = [accent, primary, info, success, warning];
  private nextColor = 0;

  /** Register an agent with a unique color from the pool. */
  registerAgent(agentId: string): void {
    if (this.streams.has(agentId)) return;
    this.streams.set(agentId, []);
    const colorFn = this.colorPool[this.nextColor % this.colorPool.length]!;
    this.agentColors.set(agentId, colorFn);
    this.nextColor++;
  }

  /** Push an event to an agent's stream. */
  push(agentId: string, event: AgentStreamEvent): void {
    const stream = this.streams.get(agentId);
    if (stream) stream.push(event);
  }

  /** Format a single event for terminal display. */
  formatEvent(event: AgentStreamEvent): string {
    const colorFn = this.agentColors.get(event.agentId) ?? muted;
    const prefix = colorFn(`[${event.agentId}]`);

    switch (event.type) {
      case 'chunk':
        return `${prefix} ${event.text ?? ''}`;
      case 'tool_start':
        return `${prefix} ${dim('○')} ${event.tool ?? '?'} ${dim(event.target ?? '')}`;
      case 'tool_complete':
        return `${prefix} ${success('✓')} ${event.tool ?? '?'} ${dim(event.detail ?? '')}`;
      case 'status':
        return `${prefix} ${muted(event.text ?? '')}`;
      case 'error':
        return `${prefix} ${error(event.text ?? 'unknown error')}`;
      default:
        return `${prefix} ${event.text ?? ''}`;
    }
  }

  /**
   * Drain all pending events from all agents and return formatted lines.
   * Events are interleaved in arrival order across agents, producing
   * a readable parallel activity log.
   */
  drain(): string[] {
    const allEvents: Array<{ ts: number; event: AgentStreamEvent }> = [];
    let seq = 0;

    for (const [agentId, events] of this.streams) {
      for (const event of events) {
        allEvents.push({ ts: seq++, event: { ...event, agentId } });
      }
    }

    // Sort by arrival order
    allEvents.sort((a, b) => a.ts - b.ts);
    // Clear each agent's event queue while preserving registration keys.
    // Map.clear() would remove the keys, causing subsequent push() calls
    // to silently drop events since push() checks streams.get(agentId).
    for (const [, events] of this.streams) {
      events.length = 0;
    }

    return allEvents.map((e) => this.formatEvent(e.event));
  }

  /** Get the color function for an agent (for use in other renderers). */
  getAgentColor(agentId: string): (t: string) => string {
    return this.agentColors.get(agentId) ?? muted;
  }
}

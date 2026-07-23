/**
 * Expandable agent transcript sections for Babel's TUI.
 *
 * When multiple agents produce output, each agent's contribution is wrapped
 * in an expandable section. Collapsed state shows a single-line summary
 * (agent name + line count + status). Expanded state shows the full output.
 *
 * Integrates with AgentStreamManager for color-coded agent output and
 * supports keyboard toggling via the keybinding system.
 *
 * Usage:
 *   const section = new AgentTranscriptSection({
 *     agentId: 'researcher',
 *     agentName: 'Research',
 *     content: 'Found 3 potential bugs...',
 *   });
 *   section.toggle(); // expand/collapse
 *   const output = section.render();
 *
 * @module agentTranscript
 */

import { Component } from './component.js';
import { Box, Text } from './primitives.js';
import { dim, muted, accent, bold, success, error, ghost, primary } from './theme.js';
import type { KeyEvent } from './keyInput.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentTranscriptOptions {
  /** Unique agent identifier */
  agentId: string;
  /** Display name */
  agentName: string;
  /** Color function for this agent's prefix */
  colorFn?: (text: string) => string;
  /** Accumulated output content (may be multi-line) */
  content?: string;
  /** Whether this section starts expanded */
  expanded?: boolean;
  /** Status badge to show */
  status?: 'active' | 'complete' | 'error' | 'blocked';
}

// ─── AgentTranscriptSection ─────────────────────────────────────────────────

export class AgentTranscriptSection extends Component {
  private agentId: string;
  private agentName: string;
  private colorFn: (text: string) => string;
  private content: string;
  private expanded: boolean;
  private status: 'active' | 'complete' | 'error' | 'blocked';

  constructor(options: AgentTranscriptOptions) {
    super();
    this.agentId = options.agentId;
    this.agentName = options.agentName;
    this.colorFn = options.colorFn ?? muted;
    this.content = options.content ?? '';
    this.expanded = options.expanded ?? false;
    this.status = options.status ?? 'active';
  }

  /** Append content to this agent's output. */
  append(text: string): void {
    if (!text) return;
    this.content += text;
    this.markDirty();
  }

  /** Set the status badge. */
  setStatus(status: 'active' | 'complete' | 'error' | 'blocked'): void {
    this.status = status;
    this.markDirty();
  }

  /** Toggle expanded/collapsed state. */
  toggle(): void {
    this.expanded = !this.expanded;
    this.markDirty();
  }

  /** Expand to show full content. */
  expand(): void {
    if (!this.expanded) {
      this.expanded = true;
      this.markDirty();
    }
  }

  /** Collapse to summary line. */
  collapse(): void {
    if (this.expanded) {
      this.expanded = false;
      this.markDirty();
    }
  }

  override handleKey(event: KeyEvent): boolean {
    // Enter or Space toggles expand/collapse
    if (event.name === 'enter' || event.name === 'space') {
      this.toggle();
      return true;
    }
    return false;
  }

  override render(): string {
    const colorFn = this.colorFn;
    const prefix = colorFn(`[${this.agentName}]`);

    // Status badge
    const badge = this.statusBadge();

    // Line count
    const lineCount = this.content ? this.content.split('\n').length : 0;

    if (!this.expanded) {
      // ── Collapsed: single summary line ─────────────────────────────
      const summary = this.content ? this.content.replace(/\n/g, ' ').slice(0, 80) : '(no output)';
      const truncated = summary.length >= 80 ? summary + '…' : summary;
      return `${badge} ${prefix} ${dim(`(${lineCount} lines)`)} ${muted(ghost(truncated))}  ${dim('[↕ expand]')}`;
    }

    // ── Expanded: full content with header and footer ─────────────────
    const lines: string[] = [];
    lines.push(`${badge} ${prefix} ${dim(`(${lineCount} lines)`)} ${dim('[↕ collapse]')}`);
    lines.push('');

    if (this.content) {
      // Indent each line of content
      for (const line of this.content.split('\n')) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`  ${ghost('(no output yet)')}`);
    }

    lines.push('');
    lines.push(dim('─'.repeat(40)));

    return lines.join('\n');
  }

  private statusBadge(): string {
    switch (this.status) {
      case 'active':
        return accent('●');
      case 'complete':
        return success('✓');
      case 'error':
        return error('✗');
      case 'blocked':
        return muted('⏸');
      default:
        return ghost('○');
    }
  }
}

// ─── AgentTranscript (collection of sections) ───────────────────────────────

export class AgentTranscript extends Component {
  private sections: Map<string, AgentTranscriptSection> = new Map();

  /** Add or get a section for an agent. */
  getOrCreate(options: AgentTranscriptOptions): AgentTranscriptSection {
    const existing = this.sections.get(options.agentId);
    if (existing) return existing;

    const section = new AgentTranscriptSection(options);
    this.sections.set(options.agentId, section);
    this.addChild(section);
    this.markDirty();
    return section;
  }

  /** Append text to a specific agent's section. */
  appendTo(agentId: string, text: string): void {
    const section = this.sections.get(agentId);
    if (section) {
      section.append(text);
      this.markDirty();
    }
  }

  /** Render all sections in insertion order. */
  override render(): string {
    if (this.sections.size === 0) return '';

    const lines: string[] = [];
    let first = true;
    for (const section of this.sections.values()) {
      if (!first) lines.push('');
      lines.push(section.render());
      first = false;
    }

    return lines.join('\n');
  }

  override handleKey(_event: KeyEvent): boolean {
    // Delegate to the focused/expanded section
    for (const section of this.sections.values()) {
      if (section.focused) return section.handleKey(_event);
    }
    return false;
  }
}

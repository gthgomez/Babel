/**
 * TypeaheadEngine — unified suggestion context for Babel's composer (C3).
 *
 * Single engine resolves slash commands, @mention file search, tab-completer
 * popups, and coordinates priority so PromptInput does not maintain parallel
 * popup state machines.
 *
 * Ghost-text inline history (InlineAutocomplete) stays a sibling — this engine
 * reports when popup modes take precedence over ghost accept on Tab.
 *
 * @module typeaheadEngine
 */

import { detectMentionTrigger, type MentionTrigger } from './mentionParser.js';
import { MentionPopup, type MentionResult } from './mentionPopup.js';
import { fuzzyMatch } from './fuzzyMatcher.js';

// ── Slash commands (shared catalog) ─────────────────────────────────────────

export interface SlashCommand {
  name: string;
  description: string;
  group: string;
}

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show help', group: 'General' },
  { name: '/theme', description: 'Change color theme', group: 'UI' },
  { name: '/model', description: 'Switch AI model', group: 'Session' },
  { name: '/mode', description: 'Switch execution mode (chat/deep/plan)', group: 'Session' },
  { name: '/project', description: 'Set project context', group: 'Session' },
  { name: '/clear', description: 'Clear conversation', group: 'Session' },
  { name: '/compact', description: 'Toggle compact mode', group: 'UI' },
  { name: '/diff', description: 'Show working diff', group: 'Git' },
  { name: '/review', description: 'Code review current changes', group: 'Git' },
  { name: '/scrollback', description: 'Open scrollback pager', group: 'UI' },
  { name: '/doctor', description: 'Check environment setup', group: 'General' },
  { name: '/resume', description: 'Resume previous session', group: 'Session' },
  { name: '/workflow', description: 'Run a DAG workflow from a JSON definition', group: 'Session' },
  { name: '/init', description: 'Initialize project config', group: 'Project' },
  { name: '/status', description: 'Show session status', group: 'Session' },
  { name: '/vim', description: 'Toggle vim mode', group: 'UI' },
  { name: '/mcp', description: 'Manage MCP servers', group: 'Tools' },
  { name: '/exit', description: 'Exit Babel', group: 'Session' },
  { name: '/keymap', description: 'Rebind keyboard shortcuts', group: 'UI' },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type TypeaheadMode = 'none' | 'slash' | 'mention' | 'completer';

export interface TypeaheadItem {
  id: string;
  label: string;
  description: string;
  insertText: string;
  group?: string;
}

export interface TypeaheadContext {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  active: boolean;
}

export interface TypeaheadViewState {
  mode: TypeaheadMode;
  items: TypeaheadItem[];
  selectedIndex: number;
  mentionQuery: string | null;
  popupPlacement: 'above' | 'below' | 'none';
}

export interface TypeaheadSyncResult {
  state: TypeaheadViewState;
  /** Set when mention mode is active and the query string changed. */
  mentionQuery: string | null;
}

export interface TypeaheadAcceptResult {
  mode: TypeaheadMode;
  line: number;
  startCol: number;
  endCol: number;
  insertText: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function filterSlashCommands(
  line0: string,
  catalog: SlashCommand[] = BUILTIN_SLASH_COMMANDS,
): SlashCommand[] {
  const filterText = line0.startsWith('/') ? line0.slice(1).toLowerCase() : '';
  if (!filterText) return catalog;

  // Build searchable text for each command so fuzzyMatch scores relevance
  const searchTextToCmd = new Map<string, SlashCommand>();
  const searchTexts: string[] = [];
  for (const cmd of catalog) {
    const text = `${cmd.name.toLowerCase()} ${cmd.description.toLowerCase()}`;
    searchTextToCmd.set(text, cmd);
    searchTexts.push(text);
  }

  const matches = fuzzyMatch(filterText, searchTexts, { preferPrefix: true });
  const candidates = matches
    .map((m) => searchTextToCmd.get(m.item))
    .filter((cmd): cmd is SlashCommand => cmd !== undefined);

  // preferPrefix boosts matches near the start of the search text, so commands
  // whose name starts with the filter text rank highest. This replaces the old
  // substring post-filter — nucleo's native scoring with preferPrefix correctly
  // ranks prefix matches above loose out-of-order matches (e.g. "/he" finds
  // "/help" before "/mode" which out-of-order-matches via 'h' and 'e' in
  // "Switch execution mode (chat/deep/plan)").
  return candidates;
}

function slashItems(commands: SlashCommand[]): TypeaheadItem[] {
  return commands.map((cmd) => ({
    id: `slash:${cmd.name}`,
    label: cmd.name,
    description: cmd.description,
    insertText: `${cmd.name} `,
    group: cmd.group,
  }));
}

function mentionItems(results: MentionResult[]): TypeaheadItem[] {
  return results.map((r) => ({
    id: `mention:${r.label}`,
    label: r.label,
    description: r.description,
    insertText: r.insertText,
  }));
}

function completerItems(matches: string[]): TypeaheadItem[] {
  return matches.map((m, i) => ({
    id: `completer:${i}:${m}`,
    label: m,
    description: '',
    insertText: m,
  }));
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class TypeaheadEngine {
  private mentionPopup = new MentionPopup();
  private mentionTrigger: MentionTrigger | null = null;
  private lastMentionQuery: string | null = null;
  private completerMatches: string[] = [];
  private slashSelected = 0;
  private completerSelected = 0;
  private mode: TypeaheadMode = 'none';
  private slashCatalog: SlashCommand[];
  private lastCtx: TypeaheadContext = {
    lines: [''],
    cursorLine: 0,
    cursorCol: 0,
    active: false,
  };

  constructor(config?: { slashCommands?: SlashCommand[] }) {
    this.slashCatalog = config?.slashCommands ?? BUILTIN_SLASH_COMMANDS;
  }

  getViewState(): TypeaheadViewState {
    return this.buildViewState();
  }

  getMode(): TypeaheadMode {
    return this.mode;
  }

  hasPopup(): boolean {
    return this.mode === 'slash' || this.mode === 'mention' || this.mode === 'completer';
  }

  isMentionActive(): boolean {
    return this.mode === 'mention';
  }

  shouldShowSlashPopup(ctx: TypeaheadContext): boolean {
    return ctx.active && ctx.cursorLine === 0 && (ctx.lines[0] ?? '').startsWith('/');
  }

  /** Recompute active mode from buffer state. */
  sync(ctx: TypeaheadContext): TypeaheadSyncResult {
    this.lastCtx = {
      lines: [...ctx.lines],
      cursorLine: ctx.cursorLine,
      cursorCol: ctx.cursorCol,
      active: ctx.active,
    };

    const mention = detectMentionTrigger(ctx.lines, ctx.cursorLine, ctx.cursorCol);
    let mentionQuery: string | null = null;

    if (mention) {
      this.mentionTrigger = mention;
      if (mention.query !== this.lastMentionQuery) {
        mentionQuery = mention.query;
        this.lastMentionQuery = mention.query;
      }
      this.mode = 'mention';
    } else if (this.shouldShowSlashPopup(ctx)) {
      this.cancelMention();
      this.mode = 'slash';
    } else if (this.completerMatches.length > 0) {
      this.cancelMention();
      this.mode = 'completer';
    } else {
      this.cancelMention();
      this.mode = 'none';
    }

    return { state: this.buildViewState(), mentionQuery };
  }

  setMentionResults(results: MentionResult[]): void {
    this.mentionPopup.setResults(results);
  }

  setCompleterPopup(matches: string[] | null): void {
    this.completerMatches = matches ?? [];
    this.completerSelected = 0;
    if (this.completerMatches.length === 0) {
      if (this.mode === 'completer') this.mode = 'none';
      return;
    }
    if (this.mode !== 'mention' && !this.shouldShowSlashPopup(this.lastCtx)) {
      this.mode = 'completer';
    }
  }

  clearCompleterPopup(): void {
    this.completerMatches = [];
    this.completerSelected = 0;
    if (this.mode === 'completer') this.mode = 'none';
  }

  moveSelection(delta: number): void {
    switch (this.mode) {
      case 'slash': {
        const filtered = filterSlashCommands(this.lastCtx.lines[0] ?? '', this.slashCatalog);
        if (filtered.length === 0) return;
        this.slashSelected = Math.max(
          0,
          Math.min(this.slashSelected + delta, filtered.length - 1),
        );
        break;
      }
      case 'mention':
        this.mentionPopup.moveSelection(delta);
        break;
      case 'completer':
        if (this.completerMatches.length === 0) return;
        this.completerSelected =
          (this.completerSelected + delta + this.completerMatches.length) %
          this.completerMatches.length;
        break;
      default:
        break;
    }
  }

  accept(ctx?: TypeaheadContext): TypeaheadAcceptResult | null {
    const activeCtx = ctx ?? this.lastCtx;

    switch (this.mode) {
      case 'slash': {
        const commands = filterSlashCommands(activeCtx.lines[0] ?? '', this.slashCatalog);
        if (commands.length === 0) return null;
        const idx =
          this.slashSelected >= 0 && this.slashSelected < commands.length
            ? this.slashSelected
            : 0;
        const cmd = commands[idx]!;
        this.slashSelected = 0;
        return {
          mode: 'slash',
          line: 0,
          startCol: 0,
          endCol: (activeCtx.lines[0] ?? '').length,
          insertText: `${cmd.name} `,
        };
      }
      case 'mention': {
        const selected = this.mentionPopup.getSelected();
        if (!selected || !this.mentionTrigger) return null;
        const trigger = this.mentionTrigger;
        const endCol = activeCtx.cursorCol;
        this.cancelMention();
        return {
          mode: 'mention',
          line: trigger.cursorLine,
          startCol: trigger.cursorCol,
          endCol,
          insertText: selected.insertText,
        };
      }
      case 'completer': {
        if (this.completerMatches.length === 0) return null;
        const text = this.completerMatches[this.completerSelected];
        if (!text) return null;
        this.clearCompleterPopup();
        return {
          mode: 'completer',
          line: activeCtx.cursorLine,
          startCol: activeCtx.cursorCol,
          endCol: activeCtx.cursorCol,
          insertText: text,
        };
      }
      default:
        return null;
    }
  }

  dismiss(): void {
    this.clearCompleterPopup();
    this.cancelMention();
    this.slashSelected = 0;
    this.mode = 'none';
  }

  cancelMention(): void {
    this.mentionTrigger = null;
    this.lastMentionQuery = null;
    this.mentionPopup.reset();
    if (this.mode === 'mention') {
      this.mode = 'none';
      this.completerMatches = [];
      this.completerSelected = 0;
    }
  }

  mentionHasResults(): boolean {
    return this.mentionPopup.hasResults();
  }

  getMentionVisibleResults(): MentionResult[] {
    return this.mentionPopup.getVisibleResults();
  }

  getMentionSelected(): MentionResult | null {
    return this.mentionPopup.getSelected();
  }

  getCompleterMatches(): readonly string[] {
    return this.completerMatches;
  }

  getCompleterSelectedIndex(): number {
    return this.completerSelected;
  }

  private buildViewState(): TypeaheadViewState {
    let items: TypeaheadItem[] = [];
    let selectedIndex = 0;
    let mentionQuery: string | null = null;
    let popupPlacement: TypeaheadViewState['popupPlacement'] = 'none';

    switch (this.mode) {
      case 'slash':
        items = slashItems(
          filterSlashCommands(this.lastCtx.lines[0] ?? '', this.slashCatalog),
        );
        selectedIndex = this.slashSelected;
        popupPlacement = 'above';
        break;
      case 'mention': {
        const visible = this.mentionPopup.getVisibleResults();
        items = mentionItems(visible);
        const selected = this.mentionPopup.getSelected();
        selectedIndex = selected ? visible.findIndex((r) => r === selected) : 0;
        if (selectedIndex < 0) selectedIndex = 0;
        mentionQuery = this.lastMentionQuery;
        popupPlacement = 'below';
        break;
      }
      case 'completer':
        items = completerItems(this.completerMatches);
        selectedIndex = this.completerSelected;
        popupPlacement = 'below';
        break;
      default:
        break;
    }

    return {
      mode: this.mode,
      items,
      selectedIndex,
      mentionQuery,
      popupPlacement,
    };
  }
}
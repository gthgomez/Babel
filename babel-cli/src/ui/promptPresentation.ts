/** Terminal presentation owner. Receives read-only editor state; never edits text or owns input. */
import {
  activeAccent,
  bgSelected,
  border,
  dim,
  muted,
  ghost,
  primary,
  sectionLabel,
  truncate,
  visibleLength,
} from './theme.js';
import { OutputBuffer } from './outputBuffer.js';
import { computeImeCursorPos, cupSequence, shouldParkImeCursor } from './imeCursor.js';
import type { TypeaheadViewState } from './typeaheadEngine.js';
import type { PromptInputPresentationTarget } from './promptView.js';

export interface PromptPresentationSnapshot {
  readonly active: boolean;
  readonly presentationTarget: PromptInputPresentationTarget | null;
  readonly lines: readonly string[];
  readonly cursorLine: number;
  readonly cursorCol: number;
  readonly cursorVisible: boolean;
  readonly imeComposing: boolean;
  readonly termWidth: number;
  readonly maxInputHeight: number;
  readonly mode: 'insert' | 'normal' | 'visual';
  readonly visualStart: Readonly<{ line: number; col: number }> | null;
  readonly visualMode: 'char' | 'line' | null;
  readonly config: { prompt: string; continuationPrompt: string; getQueuedMessages?: (() => readonly string[]) | undefined; isTaskRunning?: (() => boolean) | undefined };
  readonly typeahead: { getViewState: () => TypeaheadViewState };
  readonly ac: { getGhostText: () => string | null | undefined };
  readonly useLinearComposer: () => boolean;
  readonly getSelectionColRange: (line: number) => { start: number; end: number } | null;
  readonly renderCursor: () => void;
}

const BABEL_PROMPT_BUFFERED = process.env['BABEL_PROMPT_BUFFERED'] !== '0';

export function sanitizeUserText(text: string): string {
  if (!text) return text;
  return text.replace(/\x1b/g, "");
}

export function buildQueueViewRows(queuedMessages: readonly string[], width: number, isTaskRunning: () => boolean | undefined): string[] {
    if (queuedMessages.length === 0) return [];
    const rows = [
      isTaskRunning()
        ? dim(" Queued (Tab) · runs after current turn")
        : dim(" Queued"),
    ];
    const maxShow = Math.min(queuedMessages.length, 3);
    for (let i = 0; i < maxShow; i++) {
      const oneLine = sanitizeUserText(queuedMessages[i] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      rows.push(dim(` ↳ ${truncate(oneLine, Math.max(0, width - 3))}`));
    }
    if (queuedMessages.length > maxShow) {
      rows.push(ghost(`   +${queuedMessages.length - maxShow} more queued`));
    }
    return rows;
  }

export function buildPopupViewRows(viewState: TypeaheadViewState, width: number): string[] {
    if (viewState.mode === "none" || viewState.items.length === 0) return [];
    const maxShow = Math.min(viewState.items.length, 5);
    const rows: string[] = [];
    if (viewState.mode === "slash") {
      rows.push(border("─".repeat(Math.min(width, 40))));
    }
    if (viewState.mode === "mention") {
      rows.push(
        truncate(
          sectionLabel(` FILES MATCHING @${viewState.mentionQuery ?? ""}`),
          width,
        ),
      );
    }
    if (viewState.mode === "completer") {
      rows.push(border("─".repeat(Math.min(width, 40))));
    }
    for (let i = 0; i < maxShow; i++) {
      const item = viewState.items[i];
      if (!item) continue;
      const displayText =
        viewState.mode === "slash"
          ? ` ${item.label.padEnd(12)} ${item.description}`
          : ` ${item.label}${item.description ? `  ${ghost(item.description)}` : ""}`;
      const clipped = truncate(displayText, Math.max(0, width - 1));
      rows.push(
        i === viewState.selectedIndex ? bgSelected(clipped) : dim(clipped),
      );
    }
    return rows;
  }

export function renderPromptLinear(view: PromptPresentationSnapshot): void {
    const buf = OutputBuffer.getInstance();
    const prefix = view.config.prompt;
    const line = sanitizeUserText(
      view.lines[view.cursorLine] ?? view.lines[0] ?? "",
    );
    const before = sanitizeUserText(
      (view.lines[view.cursorLine] ?? "").slice(0, view.cursorCol),
    );
    const show = view.cursorVisible || view.imeComposing;
    buf.write(
      `\r\x1b[2K${activeAccent(prefix)}${primary(line)}\r${activeAccent(prefix)}${primary(before)}${show ? "\x1b[?25h" : "\x1b[?25l"}`,
    );
  }

export function renderPrompt(view: PromptPresentationSnapshot): void {
    if (!view.active) return;
    if (view.presentationTarget) {
      view.presentationTarget.invalidate("prompt-render");
      return;
    }
    if (view.useLinearComposer()) {
      renderPromptLinear(view);
      return;
    }

    const buf = OutputBuffer.getInstance();
    let cursorRestored = false;
    if (BABEL_PROMPT_BUFFERED) buf.beginFrame();
    try {
      const viewState = view.typeahead.getViewState();
      const queuedMessages = view.config.getQueuedMessages?.() ?? [];
      const queuedLines =
        queuedMessages.length > 0 ? Math.min(queuedMessages.length, 3) + 1 : 0;

      // Popup heights from TypeaheadEngine view state
      const slashPopupItems = viewState.mode === "slash" ? viewState.items : [];
      const slashPopupLines =
        slashPopupItems.length > 0
          ? Math.min(slashPopupItems.length, 5) + 1 // +1 for separator
          : 0;
      const mentionPopupItems =
        viewState.mode === "mention" ? viewState.items : [];
      const mentionPopupHeight =
        mentionPopupItems.length > 0
          ? Math.min(mentionPopupItems.length, 5) + 1 // +1 for header
          : 0;
      const completerItems =
        viewState.mode === "completer" ? viewState.items : [];
      const completerPopupHeight =
        completerItems.length > 0
          ? Math.min(completerItems.length, 5) + 1 // +1 for separator
          : 0;

      const inputHeight = Math.min(
        view.lines.length + completerPopupHeight + mentionPopupHeight,
        view.maxInputHeight + completerPopupHeight + mentionPopupHeight,
      );
      const totalHeight = inputHeight + slashPopupLines + queuedLines;
      const rows = process.stdout.rows || 24;
      const startRow = Math.max(1, rows - totalHeight);

      // Hide cursor during render
      OutputBuffer.getInstance().write("\x1b[?25l");

      // Save cursor, move to start row
      OutputBuffer.getInstance().write("\x1b[s");

      // Clear from startRow to bottom
      for (let r = startRow; r <= rows; r++) {
        OutputBuffer.getInstance().write(`\x1b[${r};1H\x1b[K`);
      }

      // Queued follow-ups (C2) — dim preview above prompt
      if (queuedLines > 0) {
        const headerRow = startRow;
        if (headerRow <= rows) {
          const header = view.config.isTaskRunning?.()
            ? dim(" Queued (Tab) · runs after current turn")
            : dim(" Queued");
          OutputBuffer.getInstance().write(
            `\x1b[${headerRow};1H${truncate(header, view.termWidth - 1)}`,
          );
        }
        const maxShow = Math.min(queuedMessages.length, 3);
        for (let i = 0; i < maxShow; i++) {
          const r = startRow + 1 + i;
          if (r > rows) break;
          const preview = sanitizeUserText(queuedMessages[i] ?? "");
          const oneLine = preview.replace(/\s+/g, " ").trim();
          const truncated =
            oneLine.length > view.termWidth - 4
              ? oneLine.slice(0, view.termWidth - 7) + "..."
              : oneLine;
          OutputBuffer.getInstance().write(
            `\x1b[${r};1H${dim(` ↳ ${truncated}`)}`,
          );
        }
        if (queuedMessages.length > maxShow) {
          const r = startRow + 1 + maxShow;
          if (r <= rows) {
            OutputBuffer.getInstance().write(
              `\x1b[${r};1H${ghost(`   +${queuedMessages.length - maxShow} more queued`)}`,
            );
          }
        }
      }

      const textStartBase = startRow + queuedLines;

      // Render slash command popup above prompt area (C3)
      if (viewState.mode === "slash" && slashPopupItems.length > 0) {
        const maxShow = Math.min(slashPopupItems.length, 5);
        const sepRow = startRow;
        if (sepRow <= rows) {
          OutputBuffer.getInstance().write(
            `\x1b[${sepRow};1H${border("─".repeat(Math.min(view.termWidth, 40)))}`,
          );
        }
        for (let i = 0; i < maxShow; i++) {
          const r = sepRow + 1 + i;
          if (r > rows) break;
          const item = slashPopupItems[i];
          if (!item) break;
          const displayText = ` ${item.label.padEnd(12)} ${item.description}`;
          const truncated = truncate(displayText, view.termWidth - 1);
          if (i === viewState.selectedIndex) {
            OutputBuffer.getInstance().write(
              `\x1b[${r};1H${bgSelected(truncated)}`,
            );
          } else {
            OutputBuffer.getInstance().write(`\x1b[${r};1H${dim(truncated)}`);
          }
        }
      }

      const textStart = textStartBase + slashPopupLines;

      // Render each line of the text buffer
      for (let i = 0; i < view.lines.length; i++) {
        const row = textStart + i;
        if (row > rows) break; // Can't render beyond screen

        const prefix =
          i === 0 ? view.config.prompt : view.config.continuationPrompt;
        const line = sanitizeUserText(view.lines[i] ?? "");

        OutputBuffer.getInstance().write(`\x1b[${row};1H`);

        if (view.visualStart) {
          const selRange = view.getSelectionColRange(i);
          if (selRange) {
            const before = line.slice(0, selRange.start);
            const selected = line.slice(selRange.start, selRange.end);
            const after = line.slice(selRange.end);
            const selectionHighlight = selected
              ? bgSelected(primary(selected))
              : "";
            OutputBuffer.getInstance().write(
              activeAccent(prefix) +
                primary(before) +
                selectionHighlight +
                primary(after),
            );
          } else {
            OutputBuffer.getInstance().write(
              activeAccent(prefix) + primary(line),
            );
          }
        } else {
          OutputBuffer.getInstance().write(
            activeAccent(prefix) + primary(line),
          );
        }

        // Ghost text (inline autocomplete)
        if (i === view.cursorLine) {
          const suffix = sanitizeUserText(view.ac.getGhostText() ?? "");
          if (suffix) {
            OutputBuffer.getInstance().write(ghost(suffix));
          }
        }

        // Show line continuation marker if line exceeds terminal width
        if (visibleLength(prefix + line) > view.termWidth) {
          // Truncated display — we'd need horizontal scrolling for full editing
          // For now, just show what fits
        }
      }

      // Render @mention popup below the input (C3)
      if (viewState.mode === "mention" && mentionPopupItems.length > 0) {
        const popupRow = textStart + view.lines.length;
        const maxShow = Math.min(mentionPopupItems.length, 5);

        if (popupRow <= rows) {
          const header = sectionLabel(
            ` FILES MATCHING @${viewState.mentionQuery ?? ""}`,
          );
          OutputBuffer.getInstance().write(
            `\x1b[${popupRow};1H${truncate(header, view.termWidth - 1)}`,
          );

          for (let i = 0; i < maxShow; i++) {
            const r = popupRow + 1 + i;
            if (r > rows) break;
            const item = mentionPopupItems[i];
            if (!item) break;
            const isSelected = i === viewState.selectedIndex;
            const displayText = ` ${item.label}${item.description ? `  ${ghost(item.description)}` : ""}`;
            const truncated = truncate(displayText, view.termWidth - 1);
            if (isSelected) {
              OutputBuffer.getInstance().write(
                `\x1b[${r};1H${bgSelected(truncated)}`,
              );
            } else {
              OutputBuffer.getInstance().write(`\x1b[${r};1H${dim(truncated)}`);
            }
          }
        }
      }

      // Render completion popup below the input (C3)
      if (viewState.mode === "completer" && completerItems.length > 0) {
        const popupRow = textStart + view.lines.length + mentionPopupHeight;
        if (popupRow <= rows) {
          const maxPopupLines = Math.min(completerItems.length, 5);
          OutputBuffer.getInstance().write(
            `\x1b[${popupRow};1H${border("─".repeat(Math.min(view.termWidth, 40)))}`,
          );
          for (let i = 0; i < maxPopupLines; i++) {
            const r = popupRow + 1 + i;
            if (r > rows) break;
            const item = completerItems[i];
            if (!item) break;
            const entry = item.label;
            const highlighted =
              i === viewState.selectedIndex
                ? bgSelected(
                    ` ${primary(entry.padEnd(Math.min(view.termWidth - 2, 38)))} `,
                  )
                : ` ${muted(entry)}`;
            OutputBuffer.getInstance().write(`\x1b[${r};1H${highlighted}`);
          }
          if (completerItems.length > maxPopupLines) {
            const r = popupRow + 1 + maxPopupLines;
            if (r <= rows) {
              OutputBuffer.getInstance().write(
                `\x1b[${r};1H${ghost(`  ... ${completerItems.length - maxPopupLines} more`)}`,
              );
            }
          }
        }
      }

      // Show vim mode indicator (right-aligned, dimmed)
      if (view.mode === "normal") {
        const indicator = "-- NORMAL --";
        const indicatorCol = Math.max(1, view.termWidth - indicator.length + 1);
        OutputBuffer.getInstance().write(
          `\x1b[1;${indicatorCol}H${dim(indicator)}`,
        );
      } else if (view.mode === "visual") {
        const vtype = view.visualMode === "line" ? "LINE" : "VISUAL";
        const indicator = `-- ${vtype} --`;
        const indicatorCol = Math.max(1, view.termWidth - indicator.length + 1);
        OutputBuffer.getInstance().write(
          `\x1b[1;${indicatorCol}H${dim(indicator)}`,
        );
      }

      // Position cursor
      view.renderCursor();
      cursorRestored = true;

      // Restore saved position (actually we overwrite with cursor position, so skip restore)
    } finally {
      if (!cursorRestored) {
        buf.write("\x1b[?25h");
      }
      if (BABEL_PROMPT_BUFFERED) buf.endFrame();
    }
  }

export function renderPromptCursor(view: PromptPresentationSnapshot): void {
    if (!view.active) return;
    if (view.presentationTarget) {
      view.presentationTarget.invalidate("prompt-cursor");
      return;
    }
    if (view.useLinearComposer()) {
      renderPromptLinear(view);
      return;
    }

    const buf = OutputBuffer.getInstance();
    let cursorRestored = false;
    if (BABEL_PROMPT_BUFFERED) buf.beginFrame();
    try {
      const viewState = view.typeahead.getViewState();
      const rows = process.stdout.rows || 24;
      const queuedMessages = view.config.getQueuedMessages?.() ?? [];
      const queuedLines =
        queuedMessages.length > 0 ? Math.min(queuedMessages.length, 3) + 1 : 0;
      const slashPopupItems = viewState.mode === "slash" ? viewState.items : [];
      const slashPopupLines =
        slashPopupItems.length > 0
          ? Math.min(slashPopupItems.length, 5) + 1
          : 0;
      const mentionPopupItems =
        viewState.mode === "mention" ? viewState.items : [];
      const mentionPopupHeight =
        mentionPopupItems.length > 0
          ? Math.min(mentionPopupItems.length, 5) + 1
          : 0;
      const completerItems =
        viewState.mode === "completer" ? viewState.items : [];
      const completerPopupHeight =
        completerItems.length > 0 ? Math.min(completerItems.length, 5) + 1 : 0;
      const inputHeight = Math.min(
        view.lines.length + completerPopupHeight + mentionPopupHeight,
        view.maxInputHeight + completerPopupHeight + mentionPopupHeight,
      );
      const startRow = Math.max(
        1,
        rows - inputHeight - slashPopupLines - queuedLines,
      );

      // G6 — CJK-aware caret parking (textStart = startRow + queued + slash)
      const { row: finalRow, col: finalCol } = computeImeCursorPos({
        startRow,
        queuedLines,
        slashPopupLines,
        cursorLine: view.cursorLine,
        cursorCol: view.cursorCol,
        prompt: view.config.prompt,
        continuationPrompt: view.config.continuationPrompt,
        termRows: rows,
        termCols: view.termWidth,
      });
      const show = view.cursorVisible || shouldParkImeCursor(view.imeComposing);
      buf.write(
        `${cupSequence({ row: finalRow, col: finalCol })}${show ? "\x1b[?25h" : "\x1b[?25l"}`,
      );
      cursorRestored = true;
    } finally {
      if (!cursorRestored) {
        buf.write("\x1b[?25h");
      }
      if (BABEL_PROMPT_BUFFERED) buf.endFrame();
    }
  }

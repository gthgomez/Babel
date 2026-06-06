import { renderBadge } from './badges.js';
import { muted, primary, getTerminalWidth, formatOverflow } from './theme.js';
export function renderLabeledRows(rows, options = {}) {
    const width = getTerminalWidth();
    const indent = options.indent ?? '  ';
    const labelWidth = options.labelWidth ?? 20;
    const overflow = options.overflow ?? 'truncate';
    return rows
        .filter((row) => row && row.label && row.value !== undefined)
        .map((row) => {
        const label = muted(`${String(row.label).padEnd(labelWidth)}`);
        const valueLines = formatOverflow(String(row.value), Math.max(12, width - labelWidth - indent.length - 4), overflow);
        return valueLines.map((value, index) => {
            const styledValue = primary(value);
            if (index === 0) {
                return `${indent}${label} ${styledValue}`;
            }
            return `${indent}${muted(' '.repeat(labelWidth))} ${styledValue}`;
        }).join('\n');
    })
        .join('\n');
}
export function renderCheckRows(rows, options = {}) {
    const width = getTerminalWidth();
    const indent = options.indent ?? '  ';
    const overflow = options.overflow ?? 'truncate';
    return rows
        .filter(Boolean)
        .map((row) => {
        const labelWidth = Math.min(26, options.labelWidth ?? 26);
        const labelLines = formatOverflow(String(row.label), labelWidth, overflow);
        const detailWidth = Math.max(20, width - indent.length - labelWidth - 18);
        const detailLines = formatOverflow(String(row.detail), detailWidth, overflow);
        const lineCount = Math.max(labelLines.length, detailLines.length);
        const lines = [];
        for (let index = 0; index < lineCount; index++) {
            const label = (labelLines[index] ?? '').padEnd(labelWidth);
            const detail = detailLines[index] ?? '';
            const prefix = index === 0 ? renderBadge(row.status) : muted(' '.repeat(9));
            lines.push(`${indent}${prefix} ${muted(label)} ${primary(detail)}`);
        }
        return lines.join('\n');
    })
        .join('\n');
}
export function renderOrderedList(items, options = {}) {
    const width = getTerminalWidth();
    const indent = options.indent ?? '  ';
    const overflow = options.overflow ?? 'truncate';
    return items
        .filter((item) => item !== undefined && item !== null && String(item).trim().length > 0)
        .map((item, index) => {
        const number = muted(String(index + 1).padStart(2, '0'));
        const itemLines = formatOverflow(String(item), Math.max(16, width - indent.length - 4), overflow);
        return itemLines.map((line, lineIndex) => lineIndex === 0
            ? `${indent}${number} ${primary(line)}`
            : `${indent}${muted('  ')} ${primary(line)}`).join('\n');
    })
        .join('\n');
}

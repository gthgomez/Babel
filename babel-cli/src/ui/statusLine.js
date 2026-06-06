import { accentBright, muted, padRight, primary, getTerminalWidth, formatOverflow, visibleLength } from './theme.js';
export function renderStatusRows(rows, options = {}) {
    const filtered = rows.filter((row) => row && row.label && row.value !== undefined && row.value !== null);
    if (filtered.length === 0)
        return '';
    const labelWidth = Math.min(14, Math.max(...filtered.map((row) => String(row.label).length)));
    const width = getTerminalWidth();
    const indent = options.indent ?? '  ';
    const overflow = options.overflow ?? 'truncate';
    return filtered.map((row) => {
        const labelText = muted(padRight(String(row.label), labelWidth));
        const rawValue = String(row.value);
        const badgeText = row.badge ? `${row.badge} ` : '';
        const badgeWidth = visibleLength(badgeText);
        const maxValueWidth = Math.max(12, width - labelWidth - indent.length - badgeWidth - 4);
        const valueLines = formatOverflow(rawValue, maxValueWidth, overflow);
        return valueLines.map((lineContent, index) => {
            const styledValue = row.tone === 'accent'
                ? accentBright(lineContent)
                : primary(lineContent);
            if (index === 0) {
                return `${indent}${labelText}  ${badgeText}${styledValue}`;
            }
            return `${indent}${muted(' '.repeat(labelWidth))}  ${' '.repeat(badgeWidth)}${styledValue}`;
        }).join('\n');
    }).join('\n');
}

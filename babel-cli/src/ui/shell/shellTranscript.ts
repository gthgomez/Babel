import { border, dim, error, sectionLabel, success, wrapText } from '../theme.js'
import { measureDisplayWidth, truncateDisplay } from '../textLayout.js'
import type { ToolCallPayload } from '../historyCells/types.js'

function clip(text: string, width: number): string {
  if (width <= 0) return ''
  if (measureDisplayWidth(text) <= width) return text
  if (width === 1) return truncateDisplay(text, 1)
  return `${truncateDisplay(text, width - 1)}…`
}

function cardLine(left: string, body: string, right: string, width: number): string {
  const edges = measureDisplayWidth(left) + measureDisplayWidth(right)
  const inner = Math.max(0, width - edges)
  return `${left}${clip(body, inner)}${' '.repeat(Math.max(0, inner - measureDisplayWidth(clip(body, inner))))}${right}`
}

function renderCard(title: string, bodyLines: readonly string[], width: number): string[] {
  if (width < 4) return [clip(title, width), ...bodyLines.flatMap((line) => wrapText(line, width))]
  const inner = width - 2
  const lines = [
    border(cardLine('┌', ` ${title}`, '┐', width)),
    ...bodyLines.flatMap((line) => wrapText(line, inner)).map((line) => border(cardLine('│', line, '│', width))),
    border(cardLine('└', '', '┘', width)),
  ]
  return lines
}

/** YOU / BABEL label on its own line, with markdown headings drawn as cards. */
export function formatShellSpeaker(label: 'YOU' | 'BABEL', body: string, width: number): string[] {
  const lines: string[] = [sectionLabel(label)]
  const source = body.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  while (index < source.length) {
    const heading = /^#{1,3}\s+(.+)$/.exec(source[index] ?? '')
    if (heading) {
      const title = heading[1]!.trim()
      const cardBody: string[] = []
      index += 1
      while (index < source.length && source[index] !== '') {
        cardBody.push(source[index]!)
        index += 1
      }
      lines.push(...renderCard(title, cardBody, width))
      if (source[index] === '') index += 1
      continue
    }
    const paragraph: string[] = []
    while (index < source.length && source[index] !== '' && !/^#{1,3}\s+/.test(source[index] ?? '')) {
      paragraph.push(source[index]!)
      index += 1
    }
    if (paragraph.length > 0) lines.push(...wrapText(paragraph.join(' '), Math.max(1, width)))
    if (source[index] === '') {
      lines.push('')
      index += 1
    }
  }
  return lines
}

/** Tool row with the status glyph on the right. Detail is shown only when the payload has it. */
export function formatShellTool(payload: ToolCallPayload, width: number): string[] {
  if (width <= 0) return []
  const mark =
    payload.status === 'running'
      ? dim('…')
      : payload.status === 'failed' || payload.status === 'cancelled'
        ? error('✗')
        : success('✓')
  const left = `> ${payload.tool}  ${payload.target}`
  const right = payload.detail?.trim() ? `${payload.detail.trim()} ${mark}` : mark
  const gap = width - measureDisplayWidth(left) - measureDisplayWidth(right)
  if (gap >= 1) return [`${left}${' '.repeat(gap)}${right}`]
  return [clip(`${left}  ${payload.detail?.trim() ?? ''} ${mark}`.replace(/\s+/g, ' ').trim(), width)]
}

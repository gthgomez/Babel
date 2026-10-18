/** Tool results establish source operations; rendered UI coverage needs its own evidence. */
export interface ChatInspectionCoverage {
  basis: 'recorded_tool_results'
  source_reads: number
  visual_checks: 'not_established'
  completeness: 'not_established'
}

export function chatInspectionCoverage(tools: readonly { tool: string; exit_code?: number }[] = []): ChatInspectionCoverage {
  return {
    basis: 'recorded_tool_results',
    source_reads: tools.filter(tool => (tool.tool === 'read_file' || tool.tool === 'read_range') && tool.exit_code === 0).length,
    visual_checks: 'not_established',
    completeness: 'not_established',
  }
}

export function formatChatInspectionCoverage(coverage: ChatInspectionCoverage): string {
  return `Source reads: ${coverage.source_reads} successful operations. Visual checks: not established. Coverage completeness: not established.`
}

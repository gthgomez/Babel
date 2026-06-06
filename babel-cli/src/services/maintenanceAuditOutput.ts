import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  MaintenanceAuditReportSchema,
  type MaintenanceAuditReport,
  type MaintenanceFinding,
  type WriteMaintenanceAuditOptions,
} from './maintenanceAuditContracts.js';

const MAX_HUMAN_FINDINGS_PER_SECTION = 8;

function section(lines: string[], title: string, findings: MaintenanceFinding[]): void {
  lines.push('', `${title}:`);
  if (findings.length === 0) {
    lines.push('- none');
    return;
  }
  for (const finding of findings.slice(0, MAX_HUMAN_FINDINGS_PER_SECTION)) {
    const path = finding.path ? `${finding.path}: ` : '';
    lines.push(`- ${path}${finding.evidence}`);
  }
  if (findings.length > MAX_HUMAN_FINDINGS_PER_SECTION) {
    lines.push(`- +${findings.length - MAX_HUMAN_FINDINGS_PER_SECTION} more`);
  }
}

export function formatMaintenanceAuditHuman(report: MaintenanceAuditReport): string {
  const hotspotFindings = report.findings.filter(finding => finding.category === 'oversized_file' || finding.category === 'high_coupling');
  const safeFindings = report.findings.filter(finding => finding.safe_to_apply);
  const refactorFindings = report.findings.filter(finding => !finding.safe_to_apply && (finding.category === 'oversized_file' || finding.category === 'high_coupling'));
  const docsFindings = report.findings.filter(finding => finding.category === 'broken_link' || finding.category === 'stale_doc');
  const lines = [
    'Babel Simplify Audit',
    '',
    'Summary:',
    `- Status: ${report.status}`,
    `- Mode: ${report.scan.mode}`,
    `- Files scanned: ${report.scan.files_scanned}`,
    `- Findings: ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.info} info`,
  ];
  section(lines, 'Hotspots', hotspotFindings);
  section(lines, 'Safe Cleanup', safeFindings);
  section(lines, 'Refactor Candidates', refactorFindings);
  section(lines, 'Docs Drift', docsFindings);
  lines.push(
    '',
    'Proof:',
    '- No model call: true',
    `- Docs audit: ${report.proof.docs_audit_status} (${report.proof.docs_audit_errors} errors, ${report.proof.docs_audit_warnings} warnings)`,
    `- Source provenance: ${report.proof.source_provenance_status}`,
    `- Git status entries: ${report.proof.git_status_entries}`,
    '',
    'Next:',
    report.summary.next,
  );
  if (report.artifacts.report_json) {
    lines.push('', `Report: ${report.artifacts.report_json}`);
  }
  return lines.join('\n');
}

function defaultReportDirectory(repoRoot: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  return join(repoRoot, 'runs', 'maintenance', `${stamp}-simplify`);
}

export function writeMaintenanceAuditReport(
  report: MaintenanceAuditReport,
  options: WriteMaintenanceAuditOptions,
): MaintenanceAuditReport {
  const outputPath = typeof options.outputPath === 'string' && options.outputPath.trim().length > 0
    ? resolve(options.outputPath)
    : defaultReportDirectory(options.repoRoot);
  const isJsonFile = outputPath.endsWith('.json');
  const dir = isJsonFile ? dirname(outputPath) : outputPath;
  mkdirSync(dir, { recursive: true });
  const jsonPath = isJsonFile ? outputPath : join(dir, 'maintenance_audit.json');
  const markdownPath = isJsonFile ? join(dirname(outputPath), 'maintenance_audit.md') : join(dir, 'maintenance_audit.md');
  const nextReport: MaintenanceAuditReport = {
    ...report,
    artifacts: {
      report_json: jsonPath,
      report_markdown: markdownPath,
    },
  };
  writeFileSync(jsonPath, `${JSON.stringify(nextReport, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, `${formatMaintenanceAuditHuman(nextReport)}\n`, 'utf8');
  return MaintenanceAuditReportSchema.parse(nextReport);
}

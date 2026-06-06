import { z } from 'zod';

export const MaintenanceFindingCategorySchema = z.enum([
  'oversized_file',
  'high_coupling',
  'stale_doc',
  'broken_link',
  'fixture_leak',
  'js_provenance',
  'duplicate_content',
  'unwired_service',
  'dirty_tree_risk',
]);

export const MaintenanceFindingSchema = z.object({
  severity: z.enum(['info', 'warn', 'error']),
  category: MaintenanceFindingCategorySchema,
  path: z.string().nullable(),
  evidence: z.string(),
  suggested_action: z.string(),
  safe_to_apply: z.boolean(),
  source: z.string(),
});

export const MaintenanceMetricSchema = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().optional(),
});

export const MaintenanceAuditReportSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(['pass', 'warn', 'fail']),
  generated_at: z.string(),
  repo_root: z.string(),
  scan: z.object({
    mode: z.enum(['changed', 'target', 'all']),
    target: z.string().nullable(),
    files_scanned: z.number(),
  }),
  summary: z.object({
    total_findings: z.number(),
    errors: z.number(),
    warnings: z.number(),
    info: z.number(),
    next: z.string(),
  }),
  metrics: z.array(MaintenanceMetricSchema),
  findings: z.array(MaintenanceFindingSchema),
  proof: z.object({
    no_model_call: z.literal(true),
    docs_audit_status: z.enum(['pass', 'warn', 'fail']),
    docs_audit_errors: z.number(),
    docs_audit_warnings: z.number(),
    source_provenance_status: z.enum(['pass', 'fail']),
    git_status_entries: z.number(),
  }),
  artifacts: z.object({
    report_json: z.string().nullable(),
    report_markdown: z.string().nullable(),
  }),
});

export type MaintenanceFindingCategory = z.infer<typeof MaintenanceFindingCategorySchema>;
export type MaintenanceFinding = z.infer<typeof MaintenanceFindingSchema>;
export type MaintenanceMetric = z.infer<typeof MaintenanceMetricSchema>;
export type MaintenanceAuditReport = z.infer<typeof MaintenanceAuditReportSchema>;

export interface RunMaintenanceAuditOptions {
  repoRoot: string;
  target?: string;
  all?: boolean;
}

export interface WriteMaintenanceAuditOptions {
  repoRoot: string;
  outputPath?: string | boolean;
}

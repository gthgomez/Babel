/**
 * LangfuseExporter — configures the OpenTelemetry OTLP exporter
 * to send traces to a Langfuse instance.
 *
 * Langfuse ingests OTLP traces natively at /api/public/otel/v1/traces.
 *
 * Configuration via environment variables:
 *   LANGFUSE_HOST=http://localhost:3000         (default)
 *   LANGFUSE_PUBLIC_KEY=pk-...                  (required)
 *   LANGFUSE_SECRET_KEY=sk-...                  (required)
 *
 * If keys are not set, Langfuse export is disabled (no-op).
 * Babel's existing OTel setup continues to work for other backends.
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export interface LangfuseConfig {
  host: string;
  publicKey: string;
  secretKey: string;
}

export function readLangfuseConfig(): LangfuseConfig | null {
  const host = process.env['LANGFUSE_HOST'] ?? 'http://localhost:3000';
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];

  if (!publicKey || !secretKey) {
    return null;
  }

  return { host, publicKey, secretKey };
}

export function createLangfuseExporter(config: LangfuseConfig): OTLPTraceExporter {
  const encoded = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64');

  return new OTLPTraceExporter({
    url: `${config.host}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${encoded}`,
    },
  });
}

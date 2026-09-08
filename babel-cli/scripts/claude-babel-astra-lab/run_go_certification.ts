import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { loadBabelCliEnv } from '../../src/config/envBootstrap.js';
import { OpenCodeGoApiRunner, OpenCodeGoError } from '../../src/claude-babel-astra-lab/openCodeGoApi.js';
import { OpenCodeGoCredentialError, resolveOpenCodeGoCredential } from '../../src/claude-babel-astra-lab/credentialResolver.js';
import { OPENCODE_GO_MODELS, isOpenCodeGoModel, type OpenCodeGoModel } from '../../src/claude-babel-astra-lab/models.js';

type CertificationRecord = {
  requested_model: OpenCodeGoModel;
  observed_model: string | 'UNKNOWN';
  provider: string;
  provider_route: string;
  x_opencode_session: string | 'UNKNOWN';
  http_status: number | 'UNKNOWN';
  request_id: string | 'UNKNOWN';
  latency_ms: number | 'UNKNOWN';
  input_tokens: number | 'UNKNOWN';
  output_tokens: number | 'UNKNOWN';
  cached_tokens: number | 'UNKNOWN';
  status: 'GO_MODEL_CERTIFIED' | 'AUTH_FAILURE' | 'GO_QUOTA_EXHAUSTED' | 'MODEL_UNAVAILABLE' | 'MODEL_ATTRIBUTION_FAILURE' | 'MALFORMED_RESPONSE' | 'TIMEOUT' | 'ABORTED' | 'PROVIDER_FAILURE';
  auth_status: 'PRESENT' | 'MISSING' | 'UNKNOWN';
  credential_source: 'opencode-auth-helper';
  live_request: boolean;
};

const outputRoot = resolve(process.cwd(), '..', 'benchmarks', 'claude-babel-astra-lab', 'direct-certification');

function modelsFromArgs(args: string[]): OpenCodeGoModel[] {
  const requested = args.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
  if (requested !== undefined) {
    if (!isOpenCodeGoModel(requested)) throw new Error(`MODEL_UNAVAILABLE: ${requested}`);
    return [requested];
  }
  return [...OPENCODE_GO_MODELS];
}

async function certify(model: OpenCodeGoModel, live: boolean): Promise<CertificationRecord> {
  loadBabelCliEnv();
  const base: CertificationRecord = {
    requested_model: model, observed_model: 'UNKNOWN', provider: 'opencode-go',
    provider_route: 'https://opencode.ai/zen/go/v1/chat/completions', x_opencode_session: 'UNKNOWN',
    http_status: 'UNKNOWN', request_id: 'UNKNOWN', latency_ms: 'UNKNOWN', input_tokens: 'UNKNOWN',
    output_tokens: 'UNKNOWN', cached_tokens: 'UNKNOWN', status: 'AUTH_FAILURE',
    auth_status: 'UNKNOWN', credential_source: 'opencode-auth-helper', live_request: live,
  };
  if (!live) return { ...base, auth_status: 'UNKNOWN' };

  let credential: string;
  try {
    credential = resolveOpenCodeGoCredential({ source: 'opencode-auth-helper' }).credential;
    base.auth_status = 'PRESENT';
  } catch (error) {
    if (error instanceof OpenCodeGoCredentialError) base.auth_status = 'MISSING';
    return base;
  }

  const started = Date.now();
  let requestId: string | null = null;
  let httpStatus: number | null = null;
  const runner = new OpenCodeGoApiRunner(model, { maxTokens: 64, temperature: 0 }, {
    credentialSource: 'opencode-auth-helper',
    resolvedCredential: credential,
    benchmarkRunId: `direct-${model}`,
    requestTimeoutMs: 120_000,
  });
  try {
    await runner.execute('Return exactly the JSON object {"ok":true}.', z.object({ ok: z.literal(true) }), {
      onInvocationCompleted: (event) => {
        requestId = event.provider_request_id ?? null;
        httpStatus = event.http_status ?? null;
      },
    });
    const metadata = runner.getLastInvocationMetadata();
    return {
      ...base,
      observed_model: metadata?.observed_model_id ?? 'UNKNOWN',
      x_opencode_session: runner.getLastOpenCodeSessionId() ?? 'UNKNOWN',
      request_id: requestId ?? 'UNKNOWN', http_status: httpStatus ?? 200,
      latency_ms: metadata?.latency_ms ?? Date.now() - started,
      input_tokens: metadata?.prompt_tokens ?? 'UNKNOWN', output_tokens: metadata?.completion_tokens ?? 'UNKNOWN',
      cached_tokens: metadata?.prompt_cache_hit_tokens ?? 'UNKNOWN', status: 'GO_MODEL_CERTIFIED',
    };
  } catch (error) {
    const typed = error instanceof OpenCodeGoError ? error : null;
    return {
      ...base,
      observed_model: runner.getLastInvocationMetadata()?.observed_model_id ?? 'UNKNOWN',
      x_opencode_session: runner.getLastOpenCodeSessionId() ?? 'UNKNOWN',
      request_id: requestId ?? 'UNKNOWN', http_status: typed?.httpStatus ?? httpStatus ?? 'UNKNOWN',
      latency_ms: Date.now() - started,
      input_tokens: runner.getLastInvocationMetadata()?.prompt_tokens ?? 'UNKNOWN',
      output_tokens: runner.getLastInvocationMetadata()?.completion_tokens ?? 'UNKNOWN',
      cached_tokens: runner.getLastInvocationMetadata()?.prompt_cache_hit_tokens ?? 'UNKNOWN',
      status: typed?.code ?? 'PROVIDER_FAILURE',
    };
  }
}

const live = process.argv.includes('--live');
const models = modelsFromArgs(process.argv.slice(2));
// Refuse before requesting credentials or spending calls; retained records
// are evidence and require a fresh destination for another campaign.
for (const model of models) {
  if (existsSync(resolve(outputRoot, `${model}.json`))) throw new Error('Certification output already exists; preserve it and use a fresh campaign destination.');
}
let failed = false;
for (const model of models) {
  const result = await certify(model, live);
  if (live && result.status !== 'GO_MODEL_CERTIFIED') failed = true;
  const path = resolve(outputRoot, `${model}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (failed) process.exitCode = 1;

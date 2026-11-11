import type { ValidMode } from '../cli/constants.js';
import {
  buildLiteResultPayload,
  formatLiteResultHuman,
  type LiteVerb,
  writeJson,
} from '../cli/structuredOutput.js';
import type { LiteFullRouteDecision } from '../services/liteFullRouter.js';

type LitePipelineResult = Awaited<ReturnType<typeof import('../pipeline.js').runBabelPipeline>>;

export function printLiteResult(
  result: LitePipelineResult,
  context: {
    verb: LiteVerb;
    task: string;
    mode: ValidMode;
    project?: string;
    projectRoot?: string;
    requestedModel?: string;
    requestedModelTier?: string;
    allowedTools?: string[];
    selectedLane?: Exclude<LiteVerb, 'do'>;
    routeDecision?: LiteFullRouteDecision;
    json?: boolean;
  },
): void {
  const payload = buildLiteResultPayload(result, {
    verb: context.verb,
    task: context.task,
    mode: context.mode,
    ...(context.project !== undefined ? { project: context.project } : {}),
    ...(context.projectRoot !== undefined ? { projectRoot: context.projectRoot } : {}),
    ...(context.requestedModel !== undefined ? { requestedModel: context.requestedModel } : {}),
    ...(context.requestedModelTier !== undefined
      ? { requestedModelTier: context.requestedModelTier }
      : {}),
    orchestrator: process.env['BABEL_ORCHESTRATOR_VERSION'] ?? 'v9',
    ...(context.allowedTools !== undefined ? { allowedTools: context.allowedTools } : {}),
    ...(context.selectedLane !== undefined ? { selectedLane: context.selectedLane } : {}),
    ...(context.routeDecision !== undefined ? { routeDecision: context.routeDecision } : {}),
  });

  if (context.json === true) {
    writeJson(payload);
  } else {
    process.stdout.write(`${formatLiteResultHuman(payload)}\n`);
  }
}

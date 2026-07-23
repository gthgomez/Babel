/**
 * Apply `babel run` CLI flags to process.env before pipeline / chat dispatch.
 * Extracted from workflowCommands.ts for the architectural file-size ratchet.
 */

export type RunCommandEnvOptions = {
  ask?: boolean;
  yes?: boolean;
  mode?: string;
  readOnly?: boolean;
  offline?: boolean;
  budget?: string;
  reasoningEffort?: string;
  costOptimize?: boolean;
  strictEnv?: boolean;
};

export function applyRunCommandEnvFlags(options: RunCommandEnvOptions): void {
  if (options.ask === true) {
    process.env['BABEL_ASK'] = 'true';
  }
  // Always use '1' so isBabelHeadlessEnv / hardGate / auto-approve agree.
  if (options.yes === true || options.mode === 'chat-headless') {
    process.env['BABEL_HEADLESS'] = '1';
  }
  if (options.readOnly === true) {
    process.env['BABEL_READ_ONLY'] = 'true';
  }
  if (options.offline === true) {
    process.env['BABEL_OFFLINE'] = '1';
  }
  if (options.budget !== undefined) {
    process.env['BABEL_TOKEN_BUDGET'] = options.budget;
  }
  if (options.reasoningEffort !== undefined) {
    const effort = options.reasoningEffort.toLowerCase();
    if (effort === 'low' || effort === 'medium' || effort === 'high') {
      process.env['BABEL_REASONING_EFFORT'] = effort;
    }
  }
  if (options.costOptimize === true) {
    process.env['BABEL_COST_OPTIMIZE'] = 'true';
  }
  if (options.strictEnv === true) {
    process.env['BABEL_STRICT_ENV'] = 'true';
  }
}

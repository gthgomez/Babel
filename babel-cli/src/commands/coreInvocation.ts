import type { Command } from 'commander';
import { currentInvocationSettings } from '../config/invocationSettings.js';
import { selectedConnectionModel } from '../services/connectionSettings.js';
import { resolveEffectiveSettings } from '../config/userSettings.js';
import { resolveAgentTarget } from '../services/targetResolver.js';
import { resolveProjectRoot } from '../cli/helpers.js';
import { assertFiniteBudgetSupported } from '../config/laneBudget.js';
import { CLI_COMMAND } from '../cli/commandName.js';

/** Shared invocation policy for the full command tree and plain interactive launch. */
export function registerCoreInvocation(program: Command): void {
  program.option('--connection <id>', 'Use a configured provider connection for this invocation');
  program.hook('preAction', (_root, action) => {
    const connection = program.opts()['connection'];
    const invocation = currentInvocationSettings();
    if (typeof connection === 'string' && invocation) invocation.connection = connection;
    if (action.opts()['headless'] === true && invocation) invocation['presentation'] = 'plain';
    // Nested commands such as agents run have their own offline/service contracts.
    if (action.parent !== program) return;
    const explicitModel = action.getOptionValueSource('model') === 'cli' ? action.opts()['model'] : undefined;
    if (typeof explicitModel === 'string' && invocation) invocation.model = explicitModel;
    const planArgs = action.name() === 'plan' && Array.isArray(action.processedArgs[0]) ? action.processedArgs[0] as string[] : [];
    const project = action.opts()['project'] ?? (planArgs.length > 1 && resolveProjectRoot(planArgs[0]!) ? planArgs[0] : undefined);
    const target = resolveAgentTarget({ ...(project ? { project } : {}),
      ...(action.opts()['projectRoot'] ? { projectRoot: action.opts()['projectRoot'] } : {}), cwd: process.env['BABEL_PROJECT_ROOT'] ?? process.cwd() }).targetRoot;
    if (action.name() === 'run') {
      const effective = resolveEffectiveSettings({ projectRoot: target });
      const explicitMode = action.getOptionValueSource('mode') === 'cli';
      const mode = explicitMode ? action.opts()['mode'] : effective.workflow.value === 'plan' ? 'plan' : 'chat';
      const review = action.opts()['review'] ?? effective.review.value;
      if (!['standard', 'thorough'].includes(review)) throw new Error('Review must be standard or thorough.');
      action.setOptionValueWithSource('mode', ['chat', 'chat-headless'].includes(mode) && review === 'thorough' ? 'deep' : mode, explicitMode ? 'cli' : 'config');
      if (['plan', 'deep'].includes(action.opts()['mode'])) assertFiniteBudgetSupported('Plan or thorough Work', target);
    }
    if (['run', 'plan', 'deep', 'interactive', 'app'].includes(action.name()) && action.opts()['model'] === undefined) {
      const selected = selectedConnectionModel({}, target);
      if (selected) action.setOptionValue('model', selected);
      else if (process.env['BABEL_MODEL']) action.setOptionValue('model', process.env['BABEL_MODEL']);
    } else if (['run', 'plan', 'deep', 'interactive', 'app'].includes(action.name()) && typeof action.opts()['model'] === 'string' && !action.opts()['model'].startsWith('connection/')) {
      const selected = selectedConnectionModel({ model: action.opts()['model'] }, target);
      if (selected) action.setOptionValue('model', selected);
    }
    if (['run', 'plan', 'deep'].includes(action.name()) && !action.opts()['model'] && !action.opts()['manual'] &&
      !process.env['BABEL_DESKTOP_PROVIDER'] && process.env['BABEL_PIPELINE_V9_OFFLINE'] !== '1' &&
      process.env['BABEL_LITE_OFFLINE'] !== '1' && !['1', 'true'].includes(process.env['BABEL_OFFLINE'] ?? '')) {
      throw new Error(`SETUP_REQUIRED: Run ${CLI_COMMAND} setup to choose a provider connection and exact model before starting work.`);
    }
  });
}

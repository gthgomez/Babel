/**
 * Runtime mode adapters.
 *
 * Each adapter binds one product mode to its controller. Adapters route; the
 * executor kernel, controllers, Prompt OS and evidence stores remain the
 * authorities.
 */

export { createChatRuntimeAdapter, requireRuntimeSubject } from './chat.js';
export { createPlanRuntimeAdapter } from './plan.js';
export { createDeepRuntimeAdapter } from './deep.js';

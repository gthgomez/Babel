import { createToolExecutor } from './toolExecutor.js';

/** Keeps Chat reads raw so the Chat observation layer applies line windows once. */
export const chatReadToolExecutor = createToolExecutor({
  rawFileReads: true,
});

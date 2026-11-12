/** Shared OpenAI Chat Completions protocol; vendor configuration belongs in adapters. */
export { OpenAiCompatibleRunnerBase } from './openai-chat-completions-base.js';
export { OpenAiCompatibleRunner } from './openai-chat-completions-tools.js';
export type { OpenAiCompatibleRunner as OpenAiCompatibleRunnerType } from './openai-chat-completions-tools.js';
export { ssePayloadFromTrimmedLine } from './openai-chat-completions-sse.js';
export type { FetchRedirectPolicy } from '../providerResponsePolicy.js';
export type { OpenRouterResponseMetadata } from '../providerResponseMetadata.js';

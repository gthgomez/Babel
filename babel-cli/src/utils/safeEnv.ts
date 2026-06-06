export const SECRET_ENV_KEYS = new Set([
  'DEEPSEEK_API_KEY',
  'DEEPINFRA_TOKEN',
  'DEEPINFRA_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
]);

export function getSafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !SECRET_ENV_KEYS.has(key)),
  ) as NodeJS.ProcessEnv;
}

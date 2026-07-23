/**
 * secretRedaction.ts — Secret masking for debug output, logs, and evidence bundles
 *
 * SECURITY POLICY: Execution harness and monitor output MUST NOT contain
 * plain-text secret patterns. Apply redactSecrets() to any string that may
 * appear in logs, debug output, evidence bundles, or process command lines
 * before writing or displaying it.
 *
 * See: BABEL-SEC-2026-06-18-001
 */

// Patterns that match common API key and secret formats.
// Each pattern captures the PREFIX separately so we can preserve it while
// masking the actual secret value. This lets operators recognize the key type
// without seeing the secret.
type SecretReplacement = string | ((match: string, ...groups: string[]) => string);
const SECRET_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  replacement: SecretReplacement;
}> = [
  // OpenAI / Anthropic / DeepSeek style: sk-... or sk-ant-...
  {
    name: 'api-key-sk',
    pattern: /\b(sk-[a-zA-Z0-9_-]{20,})\b/g,
    replacement: (_match: string) => {
      // Preserve prefix (first 8 chars) and last 4 chars so operators can ID the key
      if (_match.length <= 12) return 'sk-_REDACTED_';
      return `${_match.slice(0, 8)}_REDACTED_${_match.slice(-4)}`;
    },
  },
  // DeepInfra / generic long hex/token keys (typically 32+ alphanumeric chars)
  {
    name: 'api-key-hex',
    pattern: /\b([A-Za-z0-9]{32,})\b/g,
    replacement: (match: string) =>
      // Only redact if it looks like a random token (mixed case + digits)
      /[A-Z]/.test(match) && /[a-z]/.test(match) && /\d/.test(match) && match.length >= 32
        ? `${match.slice(0, 4)}_REDACTED_${match.slice(-4)}`
        : match,
  },
  // Inline env var assignment: KEY=VALUE (PowerShell $env:KEY=VALUE or bash export KEY=VALUE)
  {
    name: 'inline-env-assignment',
    pattern:
      /(\b(?:DEEPSEEK|DEEPINFRA|OPENAI|ANTHROPIC|GEMINI|COHERE|TOGETHER|GROQ|MISTRAL|REPLICATE)_API_KEY\s*=\s*)(["']?)([^"'\s;]+)\2/gi,
    replacement: '$1$2_REDACTED_$2',
  },
  // PowerShell $env:KEY=VALUE pattern
  {
    name: 'ps-env-inline',
    pattern:
      /(\$env:\s*(?:DEEPSEEK|DEEPINFRA|OPENAI|ANTHROPIC|GEMINI|COHERE|TOGETHER|GROQ|MISTRAL|REPLICATE)_API_KEY\s*=\s*)(["']?)([^"'\s;]+)\2/gi,
    replacement: '$1$2_REDACTED_$2',
  },
  // GitHub tokens
  {
    name: 'github-token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
    replacement: (_match: string) =>
      _match.length <= 12 ? 'gh__REDACTED_' : `${_match.slice(0, 7)}_REDACTED_${_match.slice(-4)}`,
  },
];

/**
 * Redact known secret patterns from a string. Safe to call on any string —
 * returns the original string if no patterns match.
 *
 * The redaction preserves the key TYPE prefix (e.g. "sk-") and the last 4
 * characters so operators can identify WHICH key was used without seeing
 * the full secret.
 */
export function redactSecrets(input: string): string {
  let output = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    // String.replace accepts both string and function replacements
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output = output.replace(pattern, replacement as any);
  }
  return output;
}

/**
 * Redact secrets from an object recursively. Returns a new object with all
 * string values passed through redactSecrets().
 */
export function redactSecretsDeep<T>(input: T): T {
  if (typeof input === 'string') {
    return redactSecrets(input) as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSecretsDeep(item)) as unknown as T;
  }
  if (input !== null && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = redactSecretsDeep(value);
    }
    return result as unknown as T;
  }
  return input;
}

/**
 * Returns true if the input string contains any known secret pattern.
 * Use this for pre-flight checks before writing output.
 */
export function containsSecrets(input: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    if (pattern.test(input)) {
      return true;
    }
  }
  return false;
}

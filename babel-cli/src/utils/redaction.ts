import { loadEnterprisePolicy, type EnterprisePolicy } from '../config/enterprisePolicy.js';

const SECRET_VALUE = '[REDACTED]';

const DEFAULT_SECRET_PATTERNS = [
  /\b(?:DEEPSEEK|DEEPINFRA|OPENAI|ANTHROPIC|GROQ|GEMINI|GOOGLE|HUGGINGFACE|HF|STRIPE|GITHUB|GH)_[A-Z0-9_]*(?:API_)?(?:KEY|TOKEN|SECRET)\s*=\s*["']?[^"'\s,;}]+/giu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"'\s,;}]+/giu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gu,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{16,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
];

function compileExtraPattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'gu');
  } catch {
    return null;
  }
}

function isSecretFieldName(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return lowerKey.includes('api_key') ||
    lowerKey.includes('apikey') ||
    lowerKey.includes('secret') ||
    lowerKey.includes('password') ||
    lowerKey === 'token' ||
    lowerKey.endsWith('_token') ||
    lowerKey.endsWith('-token') ||
    lowerKey.includes('access_token') ||
    lowerKey.includes('refresh_token');
}

export function redactSecrets(text: string, policy: EnterprisePolicy = loadEnterprisePolicy().policy): string {
  if (!policy.redaction.enabled) {
    return text;
  }

  let redacted = text;
  const extraPatterns = policy.redaction.extra_patterns
    .map(compileExtraPattern)
    .filter((pattern): pattern is RegExp => pattern !== null);

  for (const pattern of [...DEFAULT_SECRET_PATTERNS, ...extraPatterns]) {
    redacted = redacted.replace(pattern, (match) => {
      const separator = match.match(/[:=]/u);
      if (!separator || match.startsWith('Bearer ')) {
        return SECRET_VALUE;
      }
      const index = separator.index ?? -1;
      return index >= 0 ? `${match.slice(0, index + 1)} ${SECRET_VALUE}` : SECRET_VALUE;
    });
  }

  return redacted;
}

export function redactEvidenceValue<T>(value: T, policy: EnterprisePolicy = loadEnterprisePolicy().policy): T {
  if (!policy.redaction.enabled) {
    return value;
  }

  if (typeof value === 'string') {
    return redactSecrets(value, policy) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactEvidenceValue(item, policy)) as T;
  }

  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretFieldName(key)) {
        next[key] = SECRET_VALUE;
      } else {
        next[key] = redactEvidenceValue(nested, policy);
      }
    }
    return next as T;
  }

  return value;
}

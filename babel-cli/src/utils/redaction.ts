import { loadEnterprisePolicy, type EnterprisePolicy } from '../config/enterprisePolicy.js';

const SECRET_VALUE = '[REDACTED]';

const DURABLE_SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|private[_-]?key|secret|token)\b\s*[:=]\s*[^\s,;}]+/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/u,
  /\b(?:sk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_-]{30,}\b/u,
];

const DEFAULT_SECRET_PATTERNS = [
  /\b(?:DEEPSEEK|DEEPINFRA|OPENAI|ANTHROPIC|GROQ|GEMINI|GOOGLE|HUGGINGFACE|HF|STRIPE|GITHUB|GH)_[A-Z0-9_]*(?:API_)?(?:KEY|TOKEN|SECRET)\s*=\s*["']?[^"'\s,;}]+/giu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"'\s,;}]+/giu,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]+=*/gu,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{16,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_-]{50,}\b/gu,
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
  return (
    lowerKey.includes('api_key') ||
    lowerKey.includes('apikey') ||
    lowerKey.includes('secret') ||
    lowerKey.includes('password') ||
    lowerKey.includes('credential') ||
    lowerKey.includes('authorization') ||
    lowerKey.includes('private_key') ||
    lowerKey.includes('jwt') ||
    lowerKey === 'token' ||
    lowerKey.endsWith('_token') ||
    lowerKey.endsWith('-token') ||
    lowerKey.includes('access_token') ||
    lowerKey.includes('refresh_token')
  );
}

export function redactSecrets(
  text: string,
  policy: EnterprisePolicy = loadEnterprisePolicy().policy,
): string {
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

export function redactEvidenceValue<T>(
  value: T,
  policy: EnterprisePolicy = loadEnterprisePolicy().policy,
): T {
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

/** Detect credential-shaped text after the normal redaction pass. */
export function hasDurableSecretLikeText(value: string): boolean {
  return DURABLE_SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

/** Sanitize one durable string and fail closed if policy leaves a secret shape. */
export function sanitizeDurableString(
  value: string,
  field = 'value',
  policy: EnterprisePolicy = loadEnterprisePolicy().policy,
): string {
  const redacted = redactSecrets(value, policy);
  if (hasDurableSecretLikeText(redacted)) {
    throw new Error(`${field} contains secret-like durable content.`);
  }
  return redacted;
}

/** Reject raw secret-bearing objects before they enter a durable artifact. */
export function assertDurableValueSafe(
  value: unknown,
  path = 'value',
): void {
  if (typeof value === 'string') {
    if (hasDurableSecretLikeText(value))
      throw new Error(`${path} contains secret-like durable content.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDurableValueSafe(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretFieldName(key)) {
        if (nested !== SECRET_VALUE)
          throw new Error(`${path}.${key} is not allowed in a durable artifact.`);
        continue;
      }
      assertDurableValueSafe(nested, `${path}.${key}`);
    }
  }
}

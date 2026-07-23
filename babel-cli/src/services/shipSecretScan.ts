/**
 * W3.1 / C-SH-04 — Content-level secret scan for ship hard-stops.
 *
 * Complements path-based secret_candidate_changed (ciReview) with diff/body
 * pattern detection. Findings are redacted for safe operator display.
 */

export type SecretScanSeverity = 'high' | 'medium';

export interface SecretScanFinding {
  path: string;
  line?: number;
  rule: string;
  severity: SecretScanSeverity;
  /** Redacted one-line context (never full secret). */
  snippet: string;
}

export interface SecretScanReport {
  schema_version: 1;
  passed: boolean;
  finding_count: number;
  findings: SecretScanFinding[];
  scanned_paths: string[];
}

interface SecretRule {
  id: string;
  severity: SecretScanSeverity;
  /** Match against a single line (added lines preferred). */
  re: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  {
    id: 'private_key_block',
    severity: 'high',
    re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  },
  {
    id: 'aws_access_key_id',
    severity: 'high',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'github_pat',
    severity: 'high',
    re: /\bghp_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: 'github_fine_grained',
    severity: 'high',
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  {
    id: 'slack_token',
    severity: 'high',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'openai_sk',
    severity: 'high',
    re: /\bsk-[A-Za-z0-9]{20,}\b/,
  },
  {
    id: 'generic_api_key_assignment',
    severity: 'medium',
    re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"][^'"]{12,}['"]/i,
  },
  {
    id: 'password_assignment',
    severity: 'medium',
    re: /\bpassword\b\s*[:=]\s*['"][^'"]{8,}['"]/i,
  },
];

function redactSnippet(line: string, max = 96): string {
  let s = line.replace(/\s+/g, ' ').trim();
  // Mask long alnum tokens that look like secrets
  s = s.replace(/[A-Za-z0-9_\-]{16,}/g, (m) => {
    if (m.length <= 8) return m;
    return `${m.slice(0, 4)}…${m.slice(-2)}`;
  });
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

/** Scan a single text blob (file content or snippet). */
export function scanTextForSecrets(text: string, path = '(text)'): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Skip obvious placeholders / template values
    if (
      /YOUR_[A-Z0-9_]+|EXAMPLE_|placeholder|redacted|\bxxx+\b|<your[_-][^>]+>/i.test(line)
    ) {
      continue;
    }
    for (const rule of SECRET_RULES) {
      if (rule.re.test(line)) {
        findings.push({
          path,
          line: i + 1,
          rule: rule.id,
          severity: rule.severity,
          snippet: redactSnippet(line),
        });
        break; // one finding per line
      }
    }
  }
  return findings;
}

/**
 * Scan a unified diff: only added lines (`+` not `+++`) are checked.
 * Path context comes from the last `+++ b/` header.
 */
export function scanDiffForSecrets(diff: string): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  let currentPath = '(diff)';
  let newLineNo = 0;
  const lines = diff.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length).trim() || currentPath;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line);
      newLineNo = m ? Number(m[1]) - 1 : 0;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      newLineNo += 1;
      const body = line.slice(1);
      const hits = scanTextForSecrets(body, currentPath);
      for (const h of hits) {
        findings.push({
          ...h,
          line: newLineNo,
        });
      }
      continue;
    }
    if (line.startsWith(' ') || (line.startsWith('-') && !line.startsWith('---'))) {
      // context / removal: track new-side line only for context
      if (line.startsWith(' ')) newLineNo += 1;
    }
  }
  return findings;
}

/** Scan multiple files by content. */
export function scanFilesForSecrets(
  files: Array<{ path: string; content: string }>,
): SecretScanFinding[] {
  const out: SecretScanFinding[] = [];
  for (const f of files) {
    out.push(...scanTextForSecrets(f.content, f.path));
  }
  return out;
}

export function buildSecretScanReport(findings: SecretScanFinding[]): SecretScanReport {
  const paths = [...new Set(findings.map((f) => f.path))].sort();
  // High findings always fail; medium alone fails ship by default (implementor safety).
  const passed = findings.length === 0;
  return {
    schema_version: 1,
    passed,
    finding_count: findings.length,
    findings,
    scanned_paths: paths,
  };
}

/** Convert findings to ship hard-stop codes. */
export function secretFindingsToHardStopMessages(
  findings: SecretScanFinding[],
): Array<{ code: string; message: string; path?: string }> {
  return findings.map((f) => ({
    code: 'secret_content_scan',
    message: `Secret-like content (${f.rule}) at ${f.path}${f.line != null ? `:${f.line}` : ''}: ${f.snippet}`,
    path: f.path,
  }));
}

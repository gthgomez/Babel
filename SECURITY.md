# Security Policy

## Supported Versions

Security fixes are applied to the latest `main` branch and to protected release tags while they remain the recommended consumer pin.

## Reporting a Vulnerability

Please report security issues privately (GitHub Security Advisories preferred when available, or contact the repository owner).

As a solo-maintainer project:

- Reports will be acknowledged as capacity permits.
- Critical credential exposures are prioritized immediately.
- Do not open a public issue that includes live secrets or private customer data.

## Incident Response Baseline

Standard sequence when an authentic credential or private data leak is confirmed:

1. **Revoke or rotate first** — invalidate the exposed credential before anything else.
2. **Determine exposure** — tree-only vs git history; which forks/clones may have fetched it.
3. **Remove from the working tree** — delete or replace the leaked material.
4. **History rewrite only if warranted** — rewriting has side effects on forks, clones, PRs, and signatures; do it deliberately with operator approval.
5. **Coordinate collaborator cleanup** — ask anyone who may have the secret to rotate their own copies.
6. **Document the prevention change** — policy, scrub rules, CI gate, or process update so the class of leak cannot recur silently.

## Local Secret Scanning

Before publishing:

```powershell
# Current tree
gitleaks dir --redact .

# Staged changes
gitleaks git --pre-commit --staged --redact
```

Full-history scans should write reports **outside** the repository and never commit raw findings.

## Policy Source

Live scrub / scanner policy lives in `tools/security/policy.json`.
`tools/public-export/sync_policy.json` is legacy compatibility only and is not the live security policy source.

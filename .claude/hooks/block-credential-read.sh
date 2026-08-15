#!/usr/bin/env bash
# =============================================================================
# block-credential-read.sh — PreToolUse hook (matcher: Bash|PowerShell)
# Babel public repo — .claude/hooks/ (committed).
#
# PURPOSE
#   Redundancy layer for the permissions.deny block in .claude/settings.json.
#   The permission layer blocks Read tool calls on credential paths and
#   recognized in-file Bash reads (cat/head/tail/sed), but it cannot see
#   INSIDE shell commands. This hook closes the documented bypasses:
#     - PowerShell Get-Content / type / more / strings (Read-deny bypass)
#     - bash read-equivalents the permission parser does not recognize
#     - Copy-Item / git add / commit-message references to credential paths
#
# CONTRACT (verified against code.claude.com/docs/en/hooks, v2.1.233)
#   - exit 2 = HARD BLOCK, authoritative: even a JSON permissionDecision
#     "allow" cannot override it. JSON on stdout supplies the reason.
#   - exit 0 with no output = no decision; the tool call proceeds normally.
#   - Runs via Git Bash on Windows (default hook shell when Git Bash is
#     installed). If bash is missing the hook errors non-blocking (exit 1)
#     and the call proceeds — fail-open, never a false block.
#   - Timeout 10s (set in settings.json); a timed-out hook does NOT block
#     the call (documented) — fail-open.
#
# POLICY
#   Block any shell command whose command string references a credential-file
#   path (.env / .env.local / .env.<suffix> / any *.env-suffixed filename,
#   OpenSSH id_* keys, private key and cert extensions, credentials.json,
#   ~/.aws/credentials, ~/.ssh/*, secrets/). Conservative by design; on block
#   only the pattern NAME is printed — never the command text, never file
#   content.
#   Carve-outs: .env.example / .env.sample tokens are STRIPPED before matching
#   (mixed commands still block on remaining credential references);
#   metadata-only verbs (Test-Path / Get-Item / Get-ChildItem / ls / dir)
#   are permitted (contract §4 layer 6) unless a content-read verb is also
#   present.
# =============================================================================

input=$(cat)

# --- extract the command text from hook input JSON without jq ----------------
# Input shape: {"tool_name":"Bash","tool_input":{"command":"...","description":"..."}}
# Inside the command value every quote is JSON-escaped as \" so the first
# quote followed by ',' is exactly the closing quote when more fields follow.
# When the command is the last field the value ends with the literal "}} —
# stripped explicitly (braces escaped: a bare } would terminate the ${}).
after=${input#*\"command\"}
after=${after#*:}
after=${after# }
after=${after#\"}
cmd=${after%%\",*}
cmd=${cmd%\"\}\}}

[ -z "$cmd" ] && exit 0        # empty/unparseable input -> fail open (no decision)

# --- normalize: lowercase, fold separators/backslashes to '/' ----------------
lc=$(printf '%s' "$cmd" | tr '[:upper:]' '[:lower:]')
norm=$(printf '%s' "$lc" \
  | tr '"'"'"'' '/' \
  | tr '[:space:]' '/' \
  | tr ';&|()$`' '/' \
  | tr '\\' '/')

# --- strip public-template tokens (.env.example / .env.sample) ---------------
# Tokens are REMOVED before pattern matching: a mixed command like
# `cat .env.example .env` still blocks on the remaining .env reference,
# while `cat .env.example` alone passes. (An early exit here would let a
# real credential path ride through any command that also mentions the
# template.)
norm=$(printf '%s' "$norm" | sed -e 's/\.env\.example//g' -e 's/\.env\.sample//g')

# --- metadata-only inspection is permitted (contract §4 layer 6) -------------
# Test-Path / Get-Item / Get-ChildItem / ls / dir are existence/metadata
# verbs. They are exempt UNLESS a content-read verb is also present
# (Get-Content, cat, type, Read, Copy-Item, git show, more, strings, head,
# tail, sed) — e.g. `ls .env && cat .env` still blocks.
v1=${norm%%/*}
case "$v1" in
  test-path|get-item|get-childitem|ls|dir)
    case "$norm" in
      *'/get-content/'*|*'/cat/'*|*'/type/'*|*'/read/'*|*'/copy-item/'*|*'/git/show/'*|*'/more/'*|*'/strings/'*|*'/head/'*|*'/tail/'*|*'/sed/'*)
        ;;  # content-read present -> fall through to credential patterns
      *)
        exit 0 ;;
    esac ;;
esac

block() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Credential-file reference blocked by security hook (pattern: %s). Policy: never read or expose live credentials."}}' "$1"
  printf '\n'
  printf 'block-credential-read: blocked credential reference (pattern: %s)\n' "$1" >&2
  exit 2
}

# B1: any .env / .env.local / .env.<suffix> / *.env-suffixed filename
# (foo.env, FAKE-SYNTHETIC.env, foo.env.bak) — unanchored: the .env may sit
# mid-token; the template tokens (.env.example/.env.sample) were stripped
# above. Multi-dot suffixes allowed (.env.prod.backup).
[[ "$norm" =~ \.env(\.[a-z0-9_.-]*)?(/|$) ]] && block 'B1 .env'
# B2: OpenSSH private keys (id_*) as a path token (incl. .pub — conservative)
[[ "$norm" =~ (^|/)id_(rsa|ed25519|ed448|ecdsa|dsa|github)([/.]|$) ]] && block 'B2 id_* private key'
# B3: private key / keystore extensions
[[ "$norm" =~ \.(pem|p12|pfx|ppk|key|jks)(/|$) ]] && block 'B3 .pem/.p12/.pfx/.ppk/.key/.jks'
# B4: credentials.json (GCP / AWS CLI files)
[[ "$norm" =~ credentials\.json(/|$) ]] && block 'B4 credentials.json'
# B5: ~/.aws/credentials
[[ "$norm" =~ (^|/)\.aws/credentials(/|$) ]] && block 'B5 .aws/credentials'
# B6: anything under ~/.ssh/ (incl. config/known_hosts — conservative)
[[ "$norm" =~ (^|/)\.ssh/ ]] && block 'B6 .ssh/'
# B7: secrets/ directory
[[ "$norm" =~ (^|/)secrets/ ]] && block 'B7 secrets/'

exit 0

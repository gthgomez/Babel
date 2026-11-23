# Observe a routine merge decision without changing authority

Use this offline diagnostic to estimate the impact of making existing exact-head
review evidence mandatory for the GREEN lane. It does not analyze a diff, retrieve
the latest PR, authenticate a receipt, publish a check, or grant permission to
merge. Do not use its output as status-check or review evidence.

After obtaining v4 JSON directly from the existing base-rooted gate in its
approved environment, compare it with independently observed identities:

```text
node tools/merge-decision-shadow.mjs gate.json gthgomez/Babel <PR> <head-sha> <live-main-sha>
```

The report always says `authoritative: false`. `would_pass` means only that the
supplied receipt says the existing gate passed, reports independent review, is
GREEN, and matches the supplied head and current base; `would_block` explains which of those
conditions are missing. The CLI exits 0 for both diagnostic outcomes. Unreadable files or syntactically invalid JSON
fail with exit 2. Keep unexpected receipts and private policy inputs
off Git and do not publish them.

Before connecting any required check, qualify GitHub enforcement in an
authorized disposable repository with synthetic data. Confirm only a result
from the expected producer on the commit GitHub actually evaluates satisfies the
rule; missing, negative, or stale decisions must remain blocking. The trusted
evaluator must evaluate all required peers without requiring its own result.
Check base freshness and the merge executor's final head, review, and authority
checks before activation. No current workflow or ruleset uses this diagnostic.

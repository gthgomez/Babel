# Code-review contract (long form)

Router `SKILL.md` inlines the gate, schema, vote map, and empty-tree sentence. This file is resolver detail.

Collector: `pwsh -NoProfile -File <skill-dir>/scripts/collect-target.ps1`

Default target: on main, `HEAD` ∪ untracked; else merge-base ∪ untracked.

Empty → `No changes to review.` Size: warn 1MB, abort 10MB.

Lenses: bugs always; security / control-plane / structure path-routed. Load specialist SKILL.md only when selected.

Gate: meaningful + discrete + introduced here (except control-plane `PRE-EXISTING`) + demonstrable + author would fix.

Isolation: spawn read-only per specialist if the harness can; else inline. No GitHub post — use Grok `/review --pr`.

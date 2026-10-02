# Architectural budgets

Run `pwsh tools/check-architectural-budget.ps1` after installing the CLI's
locked development dependencies with `npm ci` in `babel-cli/`. The checker
uses the existing TypeScript parser; it does not download a parser at runtime.

The file-size and cast baselines remain non-regression ceilings. Files without
a recorded size ceiling must stay within 2,000 nonblank lines. An absent
baseline is not evidence that a file is new in Git. Baseline update mode records
reductions only and refuses to update while any budget violation exists.

`process-boundaries.json` is the sole registry for host exits and raw terminal
output. Each grant identifies its role, reason, and maximum executable call
count. New calls in approved files still fail. Ordinary CLI text output is
outside the live renderer boundary; raw writes under `src/ui/` require a grant.

The syntax-aware scan recognizes direct, optional, computed literal, imported,
and local aliases. Unknown computed process methods fail closed. Comments and
string literals are not executable host calls. Embedded child programs and
oracle fixtures retain their own process-lifecycle and evaluation tests; this
scan does not certify generated programs or dynamically evaluated code.
It follows local declarations and assignments, including destructuring and
conditional aliases; it does not propagate values through arbitrary function
parameters, returned objects, or cross-file calls. It is an architectural lint
check, not a proof of process isolation.
Alias accounting is conservative: a mutable alias that may refer to a process
method is counted even if a particular runtime path would overwrite it.

Keep the terminal output owner and process entrypoints small. A boundary grant
does not authorize unrelated output, a new network surface, or a privilege
change. Review registry changes independently; do not increase allowances just
to obtain a passing result. This local budget check is separate from GitHub's
required release checks.

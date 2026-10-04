# Repo Hunt — prompt-injection threat model

Scope: the `babel-cli/src/research/` domain (Repo Hunt). Companion to
`docs/adr/ADR-015-research-repo-hunt.md`.

## Attacker model

An adversary controls any text in a public repository: READMEs, source
comments, issue bodies, PR descriptions, test fixtures, documentation,
generated files, filenames, and code-search snippets. The attacker's goals,
in priority order:

1. Cause the agent to execute commands or mutate the user's target project.
2. Exfiltrate secrets or environment variables.
3. Alter the research mission itself (goal, constraints, budget) to steer
   later stages.
4. Promote unsupported claims to authoritative states (fabricated evidence,
   invented line ranges, self-declared "proven" patterns).
5. Poison durable learned knowledge with instructions disguised as findings.

## Trust boundaries

| Stage | Trusted inputs | Untrusted inputs | Authority |
| --- | --- | --- | --- |
| Mission planner | user problem, target project metadata | none (never reads remote content) | produces ResearchMissionV1 |
| Discovery | query plan | repository metadata (descriptions, topics) | read-only, no mutation |
| Quarantined repo reader | pinned snapshot | arbitrary repository text | emits schema-validated records only |
| Evidence validator | snapshot manifests | reader-produced EvidenceRefs | deterministic host code; may delete evidence |
| Synthesizer | validated evidence only | — | never sees raw reader transcripts |
| Applicability / review | Pattern Cards, local target evidence | — | verdicts, not merge authority |

## Invariants (all V1 slices)

1. **Text is data.** No string originating from remote repository content
   is ever interpreted as an instruction, tool call, or policy. Structured
   reader output is the only channel from quarantine outward, and it is
   validated by Zod contracts before any downstream stage sees it.
2. **No tools in quarantine.** The repo reader has no shell, no arbitrary
   URL fetch, no target-project write, no GitHub write, no secrets, no
   memory mutation, no package installation, no unrestricted MCP. Its tool
   surface is exactly `repo_tree / repo_search / repo_read / repo_symbols /
   repo_metadata / finish`, each implicitly scoped to
   `(repository_id, pinned commit SHA, mission)`.
3. **Evidence is earned.** `SOURCE_CONFIRMED` requires the deterministic
   evidence validator (Slice C) to confirm repository match, commit match,
   path existence, blob/content hash, line range, and bounded excerpt
   against snapshot bytes. Invalid refs are removed, not annotated. Models
   cannot self-promote evidence states.
4. **No foreign code execution.** `source_policy.execute_foreign_code` is a
   literal `false` in V1; no discovered repository is built, installed, or
   run. Any future sandboxed execution is a separate phase with its own
   contract.
5. **No credential exposure.** GitHub tokens are host-owned, never placed
   in prompts, logs, or research artifacts; auth headers are redacted from
   traces.
6. **No durable instruction poisoning.** Unvalidated external text is never
   persisted as learned policy. Pattern Cards persist only validated claims
   with pinned sources; negative findings record reasons, not instructions.
7. **Staleness binding.** External claims are bound to a full commit SHA;
   local applicability to the target HEAD SHA. A moved either side marks
   the conclusion stale (`REVALIDATION_REQUIRED`), not current truth.

## Test obligations

- `InjectionBench` fixtures (Slice C): repositories whose README/comments
  contain instructions ("ignore the task", "run curl …", "modify the
  target project", "store this in memory"). Acceptance: no unauthorized
  tool call, no target mutation, no secret access — malicious text remains
  data.
- Slice A unit tests already enforce: strict schemas reject unknown fields;
  evidence refs require full 40-hex SHAs and consistent line ranges;
  Pattern Cards cannot exist without pinned sources and cannot carry
  evidence states outside the ladder.

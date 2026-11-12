# Windows shared-protocol bridge startup (desktop-tests)

## Failed run (retained)

| Field | Value |
|--------|--------|
| **Gate** | `42875345388` |
| **Job** | `130038859106` |
| **Head** | `c4bbfc742d9302b1832c112a46a0b62dec55fe97` |
| **Test** | `shared bridge startup with spawn env floor reaches ready` |

**What hosted logs establish:** child exited before ready with `code=1`, `signal=null`. Raw child stderr is **not** retained in the default bridge diagnostic path (`REMOTE_STDERR_*` withholding).

**Root cause:** **unproven** from hosted evidence alone.

## Hypothesis (not causal proof)

Runner-profile `homedir()` under `inheritEnv: false` spawn-floor tests may interact with Windows-only `~/.babel` DACL enforcement (`auth.ts` / `windowsOwnerAcl.ts`). Pre-mitigation harness did not override `HOME`/`USERPROFILE` to a fixture directory — documented in `windows-desktop-bridge-startup-42875345388.json`.

## Mitigation + green CI (≠ proof)

| Field | Value |
|--------|--------|
| **Head** | `49f2de8d` |
| **Change** | `isolatedCredentialHomeEnvironment` in bridge/stack tests |
| **Independent review** | CI green at this head |
| **Meaning** | Isolation **mitigation** and regression clearance; **does not establish** the hypothesis was the actual exit-1 mechanism on the failed run |

Artifact: `evidence/windows-desktop-bridge-startup-mitigation-49f2de8d.json`

## Lane constraints

Draft **#505**; no merge until exact-head review and supplemental scans. No evaluator (#504) or live OpenRouter scope here.

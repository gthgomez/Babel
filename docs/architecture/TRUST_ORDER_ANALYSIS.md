# Trust Order Analysis

<!--
status: ACTIVE
last_verified: 2026-08-30
-->

The trusted merge path has four distinct inputs:

1. GitHub supplies the pull-request base and candidate head identities.
2. The trusted workflow checks out the immutable base and materializes the
   candidate by its immutable SHA.
3. The base-rooted gate validates repository policy, exact-head review and CI
   evidence, and the independent-review verifier validates signed review
   evidence against the public registries and challenge ledger.
4. Local runtime code applies its own typed policy, sandbox, and evidence
   checks; those checks do not replace the base-rooted GitHub gate.

The current #120/#126 dependency statement is explicit: #126 is the
superseding consolidation candidate, and every material #120 path is present
in the #126 candidate tree. The exact observed base/head values and the
required post-certification closure of #120 are maintained in the
reconciliation record.

The trusted read port is a separate in-process capability. Its private symbol
brand and package-export exclusion protect ordinary application code from
accidental authority access. They do not provide a hostile-process or
cryptographic boundary; process isolation, filesystem permissions, sandboxing,
and policy enforcement are required for that threat model.

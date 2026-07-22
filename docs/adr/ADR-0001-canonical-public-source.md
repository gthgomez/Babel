# ADR-0001: Canonical Public Source

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision owners:** Babel maintainers

## Context

Babel needs an unambiguous source of truth. Contributors and consumers must be
able to inspect, validate, and version it from a clean clone without depending on
an undisclosed parent workspace or a separate publication pipeline.

## Decision

`gthgomez/Babel` is the sole canonical source for Babel's public prompt library,
runtime, schemas, documentation, validation tooling, and release history.

Consumer repositories use Babel through versioned interfaces. They may supply
project overlays and repo-local rules as external configuration, but they must
not generate, overwrite, or publish canonical Babel source files.

Canonical releases use an immutable annotated tag and record the exact commit SHA.
Consumers pin both values instead of tracking `main`.

This decision establishes source authority; release readiness remains governed by
the repository's documented validation and protection requirements.

## Consequences

### Positive

- Contributors can treat a clean clone as the complete public source tree.
- Public issues and pull requests change the authoritative implementation.
- Releases and consumer pins have an unambiguous provenance.
- Consumer configuration can evolve without creating a second Babel source tree.

### Costs and constraints

- Documentation and tooling must not require private workspace files or absolute
  operator paths.
- Publication tooling outside this repository is not part of the canonical build
  or release contract.
- External overlays require a versioned loading contract before they can be
  described as supported runtime inputs.

## Alternatives considered

### Keep an undisclosed upstream repository canonical

Rejected because public contributors would work against a derivative and could
not independently verify the authoritative implementation.

### Maintain bidirectional synchronization

Rejected because conflict resolution would preserve two competing authorities and
increase the risk of non-public material entering the repository.

### Split the prompt library and runtime into separate canonical repositories

Rejected for this decision because no stable package or compatibility contract
currently justifies the additional authority boundary.

## Verification

Verify this decision through public validation, external-overlay isolation,
protected release tags, and tag-plus-SHA-pinned consumer checks.

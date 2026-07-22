# ADR-0001: Canonical Public Source

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision owners:** Babel maintainers

## Context

Babel was previously published as a sanitized derivative of a private development
repository. That arrangement left authority ambiguous: public changes could be
overwritten by a later export, contributors could not tell which repository owned
the product, and public documentation depended on concepts that did not exist in
a clean clone.

Babel needs one source of truth that contributors and consumers can inspect,
validate, and version without access to a private workspace.

## Decision

`gthgomez/Babel` is the sole canonical source for Babel's public prompt library,
runtime, schemas, documentation, validation tooling, and release history.

Private repositories consume Babel through versioned interfaces. They may supply
private project overlays and repo-local rules as external configuration, but they
must not generate, overwrite, or publish canonical Babel source files. No reverse
writer from a private repository to `gthgomez/Babel` is permitted.

Canonical releases use an immutable annotated tag and record the exact commit SHA.
Consumers pin both values instead of tracking `main`.

This decision establishes source authority. It does not, by itself, declare the
canonical cutover complete. Completion additionally requires the external-overlay
contract, repository governance, a protected release, and a successful canary
consumer migration.

## Consequences

### Positive

- Contributors can treat a clean clone as the complete public source tree.
- Public issues and pull requests change the authoritative implementation.
- Releases and consumer pins have an unambiguous provenance.
- Private configuration can evolve without creating a second Babel source tree.

### Costs and constraints

- Documentation and tooling must not require private workspace files or absolute
  operator paths.
- Existing private-to-public exporters must remain disabled and be removed after
  the migration is complete.
- Private overlays need a versioned external loading contract before they can be
  described as supported runtime inputs.
- Historical documents may describe the former export architecture, but active
  documentation must describe the canonical model.

## Alternatives considered

### Keep the private repository canonical

Rejected because public contributors would continue working against a derivative,
and a reverse export could overwrite public history.

### Maintain bidirectional synchronization

Rejected because conflict resolution would preserve two competing authorities and
increase the risk of private material entering the public repository.

### Split the prompt library and runtime into separate canonical repositories

Deferred. The first canonical release depends on the full repository shape, and no
stable package or compatibility contract currently justifies that split.

## Verification

The migration is complete only when the cutover plan's acceptance gates pass,
including public validation, external-overlay isolation, protected release tags,
and a tag-plus-SHA-pinned canary consumer.

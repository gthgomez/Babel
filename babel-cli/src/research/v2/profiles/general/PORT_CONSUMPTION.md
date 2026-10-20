# Shared port consumption (Agent B)

Agent B will import shared types from Agent A's contract package only. This file records **needs**, not definitions.

## SourceAccessPort (required)

| Operation | Adapter use |
|-----------|-------------|
| Search admission | Web discovery with receipts and explicit failure categories |
| Fetch/read admission | HTML and document bytes with policy enforcement, truncation, cancellation |
| Operation identity | Correlate passages to admitted operations for durability |

## SourceAdapter (implemented by B, registered by A)

- `discover(context, query)` → ranked candidates + provider metadata
- `read(context, sourceRef)` → `SourceRevision` + passages or typed failure

## ResearchProfileDefinition (general instance owned by B)

Declarative only: question templates, source preferences, report sections, rubric hooks, optional pure `validateFinding`.

## Explicit non-goals for B

- No `ResearchModelPort` implementation
- No `ResearchStore` / engine scheduling
- No CLI command registration

## Interface requests queued for contract review

1. Discovery result type shared with technical profile search snippets.
2. Standard locator union for HTML (heading path) and PDF (page).
3. Fake port package path for deterministic adapter tests.

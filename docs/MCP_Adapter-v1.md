<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Babel MCP Adapter v1

Babel v10 Phase 1 exposes a read-only MCP adapter for the control plane. The adapter runs over stdio via `babel mcp` and is intentionally limited to safe inspection surfaces backed by the compiler and catalog: catalog inspection, typed stack resolution, instruction stack preview, and manifest preview.

## Scope

The adapter is for control-plane introspection only. It exists to let external hosts inspect Babel's prompt catalog and compile typed routing intent into the exact ordered prompt stack Babel would use at runtime, without turning Babel into an execution runtime or code-generation surface.

## Phase 1 Tools

- `babel_catalog_inspect`
- `babel_stack_resolve`
- `babel_instruction_stack_preview`
- `babel_manifest_preview`

## Safety Constraints

- No execution tools
- No shell access
- No file mutation
- No task routing or pipeline invocation
- No raw prompt authoring or prompt mutation
- No arbitrary filesystem browsing
- No Local Mode policy mutation

## Invocation Shape

Run the server with `babel mcp` and connect over stdio using the MCP `initialize`, `tools/list`, and `tools/call` flow. The tool inputs reuse Babel's typed `instruction_stack` and `resolution_policy` contracts so previews and compiled manifests stay aligned with the v9 compiler lane.

## Output Discipline

`babel_stack_resolve` and `babel_manifest_preview` return compiler-backed manifest data only. `babel_instruction_stack_preview` returns ordered entry metadata and budget summaries. `babel_catalog_inspect` returns filtered catalog metadata such as layer, path, dependencies, conflicts, tags, project, and token budget.

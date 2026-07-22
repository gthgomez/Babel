<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Babel MCP Adapter v1

This is the canonical specification for Babel's current read-only MCP adapter.
The adapter runs over stdio via `babel mcp` and is intentionally limited to
inspection surfaces backed by the compiler and catalog: catalog inspection,
typed stack resolution, instruction stack preview, manifest preview, and
executor-tool metadata.

## Scope

The adapter is for control-plane introspection only. It exists to let external hosts inspect Babel's prompt catalog and compile typed routing intent into the exact ordered prompt stack Babel would use at runtime, without turning Babel into an execution runtime or code-generation surface.

## Available Tools

- `babel_catalog_inspect`
- `babel_stack_resolve`
- `babel_instruction_stack_preview`
- `babel_manifest_preview`
- `babel_executor_tools_list`

## Safety Constraints

- No execution tools
- No shell access
- No file mutation
- No task routing or pipeline invocation
- No raw prompt authoring or prompt mutation
- No arbitrary filesystem browsing
- No Local Mode policy mutation
- Executor tool listings are metadata-only. Mutating tool metadata is hidden by default and, when explicitly requested with `include_mutating: true`, remains non-callable.

## Invocation Shape

Run the server with `babel mcp` and connect over stdio using the MCP `initialize`, `tools/list`, and `tools/call` flow. The tool inputs reuse Babel's typed `instruction_stack` and `resolution_policy` contracts so previews and compiled manifests stay aligned with the v9 compiler lane.

## Output Discipline

`babel_stack_resolve` and `babel_manifest_preview` return compiler-backed manifest data only. `babel_instruction_stack_preview` returns ordered entry metadata and budget summaries. `babel_catalog_inspect` returns filtered catalog metadata such as layer, path, dependencies, conflicts, tags, project, and token budget.

`babel_executor_tools_list` returns executor registry metadata only. Its default response includes read-only tool metadata. `include_mutating: true` may include mutating tool metadata for documentation or policy review, but those tools are labeled `metadata_only_mutating_tool_not_callable` and cannot be invoked through Babel MCP.

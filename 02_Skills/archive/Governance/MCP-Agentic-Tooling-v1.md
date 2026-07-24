# MCP Agentic Tooling (v1.0)

## Purpose
Standardizes tool use using the Model Context Protocol (MCP) to ensure interoperability across different agents and frameworks.

## Rules
1. **MCP Separation of Concerns**: Tools and data access should be implemented as **MCP Servers**. Agents act as **MCP Clients** that consume these servers.
2. **Standardized Tool Schemas**: Use JSON Schema for all MCP tool definitions. Include clear descriptions and required parameters to ensure the LLM can invoke them accurately.
3. **Multi-Agent Tool Sharing**: Tools registered via an MCP server should be accessible to all agents in the swarm, preventing the need for duplicate tool implementation.
4. **Context Retrieval**: Use MCP "Resources" for structured data access (e.g., database records, API documentation) rather than raw file reads when a server is available.
5. **Security Isolation**: MCP servers must enforce their own access controls. Do not rely on the client agent to "police" tool usage.
6. **Prompt Interoperability**: Use MCP "Prompts" to store reusable instruction templates that can be shared across agents (e.g., a "QA Review" prompt).
7. **Streaming Tool Output**: For long-running tools, use the MCP streaming interface to provide incremental feedback to the agent/user.

## Implementation Standard (2026)
- **Transport**: Default to stdio for local tools and SSE (Server-Sent Events) for remote tools.
- **Discovery**: Use the MCP `list_tools` and `list_resources` capabilities for dynamic tool discovery at runtime.
- **Lifecycle**: Tools should be stateless. Persistent state should be managed by the server-side database/resource, not the agent's memory.

## Verification
- Run `mcp inspector` or equivalent to validate server health and schema correctness.
- Verify that multiple agents can call the same tool and receive consistent results.
- Confirm that error messages from the MCP server are human-readable and actionable for the agent.

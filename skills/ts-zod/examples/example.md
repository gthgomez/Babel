# Example

User task:

```text
Validate this webhook payload and store it safely.
```

Expected behavior:

- Read the existing handler and any current schema.
- Define a strict Zod schema at the boundary.
- Parse the raw payload before business logic.
- Infer the TypeScript type from the schema.
- Add accepted and rejected fixture tests.

# Example

User task:

```text
Fix the failing API response type.
```

Expected behavior:

- Read the route handler, response type/schema, and failing test/log.
- Search for consumers of the response shape.
- Mark any consumers not verified.
- Only then classify the change and edit.

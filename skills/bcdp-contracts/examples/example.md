# Example

User task:

```text
Rename `userId` to `ownerId` in the API response.
```

Expected behavior:

- Search for all response consumers.
- Classify as BREAKING unless a compatibility bridge is kept.
- Update in-repo consumers or emit a migration plan.
- Verify tests that cover both producer and consumers.

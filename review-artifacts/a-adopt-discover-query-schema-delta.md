# A adopt: `discover_query` schema delta (B `0195ec26` + narrow fix)

**Only `common.ts` contract change for A to reconcile:**

```typescript
discover_query: z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: 'discover_query must be non-empty after trim',
  })
  .transform((value) => value.trim())
  .optional(),
```

**Runtime (B-owned, already shipped):** `resolveRepositorySlotDiscoverQuery` uses `pin.discover_query` only when defined (post-parse trimmed string). Whitespace-only values **fail mission parse**; they do not fall back to global `discoverQuery`.

**Campaign-only query strings (not production logic):** see `review-artifacts/t-l1-discover-query-tree-first-hit.json`.

<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Prisma ORM (v1.0)
**Category:** Database
**Status:** Active

---

## 1. Migration Workflow

Prisma has two migration commands with fundamentally different purposes:

```bash
# Development: generates + applies a migration, updates Prisma Client
npx prisma migrate dev --name descriptive_name

# Production / CI: applies pending migrations only, does NOT generate new ones
npx prisma migrate deploy

# After schema change, regenerate the client (always run after schema edits)
npx prisma generate

# Inspect DB state vs schema
npx prisma migrate status
```

**Rules:**
- `migrate dev` is for local development only. Never run it in CI or production.
- `migrate deploy` is idempotent — safe to run on every deploy; only applies unapplied migrations.
- Run `prisma generate` after any `schema.prisma` change. Without it, TypeScript types are stale and the compiled client may be out of sync.
- Migration files in `prisma/migrations/` are immutable once committed. Never edit a migration file after it has been applied anywhere — create a new migration instead.
- Name migrations descriptively: `add_run_telemetry`, `add_stripe_customer_id`, not `migration_001`.

---

## 2. Environment Variables

```env
# Connection pooler URL (used by Prisma Client at runtime)
DATABASE_URL="postgresql://..."

# Direct connection URL (used by prisma migrate — bypasses pooler)
DIRECT_URL="postgresql://..."
```

**Why two URLs?** Connection poolers (PgBouncer, Supabase's pooler) use transaction-mode pooling, which is incompatible with Prisma Migrate's advisory lock mechanism. Migrations must always run against the direct connection.

```prisma
datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  directUrl  = env("DIRECT_URL")
}
```

**Rules:**
- Both vars are required when using a connection pooler. Missing `DIRECT_URL` causes migration failures with confusing error messages.
- Never hardcode connection strings. Both vars must come from environment.

---

## 3. Schema Conventions

### Naming: camelCase fields, snake_case DB columns

```prisma
model Run {
  id              String   @id @default(cuid())
  runId           String   @unique @map("run_id")        // ← @map bridges camelCase ↔ snake_case
  siteUrl         String   @map("site_url")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@map("runs")  // ← table name in DB (plural snake_case)
}
```

**Rules:**
- Prisma fields use `camelCase`. DB columns use `snake_case`. Bridge with `@map("column_name")`.
- Table names use `@@map("plural_snake_case")`.
- Primary key: `@id @default(cuid())` for app-generated IDs. Use `@default(uuid())` only if cross-system UUID compatibility is required.
- Always add `@@map` — it keeps the Prisma schema readable without coupling TypeScript names to DB conventions.

### Timestamps

```prisma
createdAt DateTime @default(now()) @map("created_at")
updatedAt DateTime @updatedAt @map("updated_at")  // auto-updated by Prisma on every update
```

**Rules:**
- `@updatedAt` is managed by Prisma, not the DB. It requires Prisma Client to update — a raw SQL `UPDATE` will not update it automatically.
- Always use `@map` on timestamp fields.

### Optional fields and defaults

```prisma
verdict         Verdict?                   // nullable — no @default
overallScore    Decimal? @db.Decimal(4,1)  // nullable Decimal
requiredPhrases String[] @default([])      // non-null array, empty by default
```

**Rules:**
- Mark fields that may be absent as nullable with `?`. Don't use `@default("")` to fake optionality.
- Arrays default to `@default([])`, not `null`. A missing array is an empty array.
- `@db.Decimal(4,1)` controls precision at the DB level. Always specify precision for financial or scored values — without it, Postgres uses a variable-precision decimal which may drift.

---

## 4. Relations

```prisma
model Run {
  id            String         @id @default(cuid())
  manifestFlows ManifestFlow[]
  @@map("runs")
}

model ManifestFlow {
  id    String @id @default(cuid())
  runId String @map("run_id")

  run   Run    @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, flowId])   // compound uniqueness
  @@index([runId])            // explicit index for FK lookups
  @@map("manifest_flows")
}
```

**Rules:**
- Always add `onDelete: Cascade` for child records that should not outlive their parent.
- Add `@@index` on foreign key columns. Prisma does not auto-create indexes for FK columns (unlike some ORMs).
- Use `@@unique([a, b])` for compound uniqueness — a run can only have one flow with a given flowId.
- Both sides of a relation must be declared: the array field on the parent and the scalar + `@relation` on the child.

---

## 5. Enums

```prisma
enum Verdict {
  Professional
  Mixed
  Crude
  Needs_verification
}
```

**Rules:**
- Enum values are PascalCase by convention in this stack. They map directly to the DB enum type.
- Adding a new enum value is backward compatible (additive). Removing or renaming a value is a BREAKING change — every query filtering or writing that enum value is affected.
- After adding an enum value, run `prisma migrate dev --name add_verdict_value` and `prisma generate`.

---

## 6. Backward-Compatible Schema Evolution

| Change | Classification | Notes |
|--------|---------------|-------|
| Add nullable field (`field Type?`) | COMPATIBLE | Existing rows get `null` |
| Add field with `@default(...)` | COMPATIBLE | Existing rows get the default |
| Add new table | COMPATIBLE | No effect on existing tables |
| Add new enum value | COMPATIBLE | Additive |
| Remove field | BREAKING | Existing code referencing it fails at compile time |
| Rename field | BREAKING | Treat as remove + add; requires data migration |
| Change field type | BREAKING | Usually requires data migration + multiple deploy steps |
| Remove enum value | BREAKING | Runtime failures for any stored data using that value |
| Add `@unique` to existing field | RISKY | Migration will fail if existing data has duplicates |

**Rules:**
- Non-nullable new fields without defaults are BREAKING for existing rows — always use `?` or `@default`.
- Use the BCDP protocol before any RISKY or BREAKING schema change.

---

## 7. Prisma Client — Singleton Pattern

```typescript
// src/lib/prisma.ts — the canonical singleton
import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

**Why:** Next.js hot module reloading creates new module instances in development. Without the global guard, each reload creates a new `PrismaClient` and eventually exhausts the connection pool.

**Rules:**
- Import from `@/lib/prisma` (the singleton), never `new PrismaClient()` directly in application code.
- In serverless/edge environments (Next.js Server Components, API routes), the singleton is safe because the process is short-lived.
- Never call `prisma.$disconnect()` in application code unless you are writing a one-off script. In a server, disconnecting the global singleton breaks subsequent requests.

---

## 8. Common Query Patterns

```typescript
// Find one or null (no error if missing)
const run = await prisma.run.findUnique({ where: { runId } });
// run is Run | null

// Find first matching (when not using @unique)
const flow = await prisma.manifestFlow.findFirst({ where: { runId, flowId } });

// Create with nested relations
const run = await prisma.run.create({
  data: {
    runId: "run-001",
    siteUrl: "https://example.com",
    // ... other fields
    manifestFlows: {
      create: [{ flowId: "f1", flowLabel: "Sign In", ... }],
    },
  },
});

// Update (fails if record not found — use upsert if needed)
await prisma.run.update({
  where: { runId },
  data: { overallScore: 8.5, verdict: "Professional" },
});

// Upsert
await prisma.run.upsert({
  where: { runId },
  update: { overallScore: 8.5 },
  create: { runId, siteUrl: "...", overallScore: 8.5, ... },
});
```

---

## 9. High-Risk Zones

| Zone | Risk |
|------|------|
| Editing a committed migration file | Breaks other environments where migration was already applied |
| New non-nullable field without `@default` | Runtime failure on existing rows |
| `migrate dev` in CI/production | Generates unwanted migration files, may drop schema state |
| Missing `DIRECT_URL` | Migration failures with misleading errors |
| `new PrismaClient()` in hot-module-reloaded code | Connection pool exhaustion in development |
| Removing / renaming enum values | Stored data using old values causes runtime errors |
| Missing `@@index` on FK columns | Silent full-table scans on join queries |

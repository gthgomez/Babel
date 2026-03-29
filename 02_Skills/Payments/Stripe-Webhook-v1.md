<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Stripe Webhook (v1.0)
**Category:** Payments
**Status:** Active

---

## 1. The Two Rules That Override Everything Else

**Rule 1 — Signature first, always.** Verify the Stripe webhook signature before reading, parsing, or acting on the event body. Without verification, any party can POST arbitrary JSON to your endpoint and fake billing events.

**Rule 2 — Status code semantics are load-bearing.** Return `400` on signature failure (tells Stripe the delivery was bad — it retries). Return `200` on all other errors (tells Stripe the delivery was acknowledged — it does not retry). The wrong status code causes either unprocessed payments or an infinite retry storm.

---

## 2. Deno Implementation (Supabase Edge Function)

### Environment variables

```typescript
// Boot-time: validate before first request, not on first use
const STRIPE_SECRET_KEY      = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const STRIPE_WEBHOOK_SECRET  = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL            = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
```

Set via Supabase CLI (never commit, never hardcode):
```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the Supabase Edge Runtime — do not set them manually.

### Stripe client — Deno-specific initialization

```typescript
import Stripe from "npm:stripe@17";

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",  // pin to avoid type drift on SDK updates
  httpClient: Stripe.createFetchHttpClient(), // required: Stripe's default uses Node http module
});
```

**Why `createFetchHttpClient()`:** Stripe's SDK defaults to Node's `http` module which is unavailable in Deno. Without this, the webhook function throws at runtime.

---

## 3. Request Handler Pattern

```typescript
Deno.serve(async (req: Request): Promise<Response> => {
  // ── Guard: only POST ──────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Guard: env vars present ───────────────────────────────────────────────
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    log("error", "WEBHOOK_CONFIG_ERROR");
    return new Response(JSON.stringify({ error: "Server misconfiguration" }), { status: 500 });
  }

  // ── Step 1: Read raw body — BEFORE any parsing ────────────────────────────
  // Signature is computed over the exact bytes received.
  // JSON.parse + re-stringify would invalidate it.
  const body = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), { status: 400 });
  }

  // ── Step 2: Verify signature ──────────────────────────────────────────────
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // 400 = bad delivery. Stripe will retry until signature matches or endpoint is fixed.
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 400 });
  }

  // ── Step 3: Route and handle ──────────────────────────────────────────────
  // From here, all errors return 200 to prevent retry loops.
  // Log everything — manual remediation beats unrecoverable retry storms.

  if (event.type === "checkout.session.completed") {
    // handle upgrade ...
  }

  if (event.type === "customer.subscription.deleted") {
    // handle cancellation ...
  }

  // Unhandled types: silently acknowledge (200). Stripe sends many event types.
  return new Response(JSON.stringify({ received: true }), { status: 200 });
});
```

---

## 4. Status Code Decision Table

| Situation | Status | Why |
|-----------|--------|-----|
| Signature verification failure | **400** | Marks delivery as failed; Stripe retries |
| Missing `stripe-signature` header | **400** | Same — delivery is invalid |
| Method not POST | **405** | Stripe only POSTs; non-POST is a probe or misconfiguration |
| Server misconfiguration (missing env var) | **500** | Fail loudly during setup; not a retry scenario |
| DB write failure | **200** | Event was valid; retry won't fix a DB error — log for manual fix |
| Account not found | **200** | Valid event; no matching record is an app-level condition |
| Event already handled (idempotency) | **200** | Acknowledge re-delivery, take no action |
| Unhandled event type | **200** | Stripe sends dozens of event types; silent ack is correct |

---

## 5. Idempotency

Stripe delivers webhooks **at least once**. The same event may arrive multiple times (network retries, Stripe's own retry policy). Your handler must be idempotent.

```typescript
// Pattern: check current state before writing

// checkout.session.completed — check if already upgraded
const { data: account } = await supabaseAdmin
  .from("customer_accounts")
  .select("billing_tier, stripe_customer_id")
  .eq("account_id", accountId)
  .maybeSingle();

if (account?.billing_tier === "pro") {
  // Already upgraded — acknowledge, take no action (or backfill missing fields)
  return new Response(JSON.stringify({ received: true, action: "already_pro" }), { status: 200 });
}

// Only write if state differs from desired
await supabaseAdmin.from("customer_accounts").update({ billing_tier: "pro" }).eq(...);
```

**Rules:**
- Always read current state before writing. Never blindly UPDATE without checking if already applied.
- The idempotency check must use the same identifier as the write (same `account_id`, same `stripe_customer_id`).
- Backfill missing related data (e.g. `stripe_customer_id`) even on idempotent re-delivery — this handles accounts created before a column was added.

---

## 6. Account Correlation

Two Stripe event types use different identifiers to reference your account:

| Event type | Stripe field | Maps to |
|---|---|---|
| `checkout.session.completed` | `session.client_reference_id` | Your app's `account_id` (must be set in the payment link URL before checkout) |
| `customer.subscription.deleted` | `subscription.customer` | `stripe_customer_id` (must be stored on `checkout.session.completed`) |

```typescript
// Set client_reference_id when building the Stripe payment link URL:
// https://buy.stripe.com/... ?client_reference_id=<account_id>

// checkout.session.completed → persist stripe_customer_id for future events
const accountId = session.client_reference_id;          // your ID
const stripeCustomerId = session.customer as string;     // Stripe's ID
// Store stripeCustomerId on the account row so subscription.deleted can look it up
```

**Rules:**
- If `client_reference_id` is absent on `checkout.session.completed`, the session did not originate from your app — log and return 200 (not an error).
- Always persist `stripe_customer_id` on the first `checkout.session.completed`. Without it, cancellation events cannot be resolved to your accounts.
- If `stripe_customer_id` is missing on the account at cancellation time, log with `ACTION REQUIRED` and return 200 — manual DB remediation is needed.

---

## 7. Service Role Justification

Stripe webhooks are server-to-server calls from Stripe's infrastructure. There is no user JWT present. The service role client is the correct choice here — this is one of the few legitimate cases for bypassing RLS.

```typescript
// Justified: server-to-server billing write, no user session exists
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
```

Document this justification in code comments. Any reviewer seeing `SUPABASE_SERVICE_ROLE_KEY` in an edge function should be able to immediately understand why it's safe here.

---

## 8. Logging Pattern

```typescript
function log(level: "info" | "warn" | "error", tag: string, payload: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), tag, ...payload });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

// Always log with a structured tag and relevant identifiers
log("info",  "STRIPE_FULFILLMENT_SUCCESS",      { account_id, session_id });
log("error", "STRIPE_FULFILLMENT_DB_ERROR",     { account_id, session_id, error: dbError.message });
log("warn",  "STRIPE_MISSING_CLIENT_REFERENCE_ID", { session_id: session.id });
```

**Rules:**
- Every log entry must have a unique `tag` string. This is what you search for in Supabase function logs.
- For every DB error case, include `// ACTION REQUIRED:` comments with the manual SQL remediation query — DB errors that return 200 require human follow-up.
- Never log the value of `stripe-signature`, `STRIPE_SECRET_KEY`, or `STRIPE_WEBHOOK_SECRET`. Log key names only.

---

## 9. Local Testing

```bash
# Install Stripe CLI
stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook

# Trigger a test event
stripe trigger checkout.session.completed

# In a separate terminal: serve the function locally
supabase functions serve stripe-webhook --env-file .env
```

**Rules:**
- Use `stripe listen` during development — it signs test events with a test webhook secret (`whsec_test_...`).
- The test webhook secret is different from the production signing secret. Use separate `.env` vars or branches.
- Always verify that `constructEventAsync` succeeds with the test secret before testing event logic.

---

## 10. High-Risk Zones

| Zone | Risk |
|------|------|
| Reading `req.json()` before `req.text()` | Body stream is consumed; `constructEventAsync` gets empty string, signature always fails |
| Returning 400 for DB errors | Stripe enters retry loop; same DB error repeats indefinitely |
| Returning non-200 for unhandled event types | Stripe retries and floods logs with expected non-events |
| Missing idempotency check | Double-upgrade or double-downgrade on re-delivery |
| Not storing `stripe_customer_id` | Cancellation events cannot be resolved to app accounts |
| Missing `createFetchHttpClient()` | Runtime crash in Deno — Node `http` module not available |
| Unpinned Stripe SDK version | Breaking API shape changes silently in URL imports |

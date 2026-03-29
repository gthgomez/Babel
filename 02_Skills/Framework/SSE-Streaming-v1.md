<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: SSE Streaming (v1.0)
**Category:** Framework / Protocol
**Status:** Active

---

## 1. What SSE Is (and Is Not)

**Server-Sent Events** is a one-directional HTTP stream from server to client. The server pushes `data:` frames; the client reads them via `EventSource` or a `fetch` + `ReadableStream` loop.

This skill covers:
- **Server side:** producing a valid SSE response from a Deno Edge Function
- **Normalization:** converting provider-native streams (Anthropic, OpenAI, Google) into a provider-agnostic contract
- **Client side:** consuming the normalized stream and parsing response metadata headers

**This is not WebSockets.** SSE is half-duplex. If you need bidirectional communication, SSE is the wrong choice.

---

## 2. SSE Wire Format

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"type":"content_block_delta","delta":{"text":"Hello"}}

data: {"type":"content_block_delta","delta":{"text":" world"}}

data: [DONE]

```

**Rules — every item is mandatory:**
- `Content-Type: text/event-stream` — without this, browsers don't treat the response as SSE.
- `Cache-Control: no-cache` — without this, proxies buffer the entire response before forwarding.
- Each `data:` line ends with `\n\n` (two newlines). A single `\n` is a multi-line continuation, not a new event.
- The `[DONE]` sentinel signals stream end. Always emit it before closing, even on error (after an error event).
- Keep-alive: emit a `: ping\n\n` comment every 15–30s on long-running streams. Idle connections are dropped by load balancers and mobile networks.

---

## 3. Server — Producing SSE (Deno Edge Function)

```typescript
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Fire-and-forget: stream in background, return response immediately
  const streamPromise = (async () => {
    try {
      // Fetch from upstream provider
      const upstreamResponse = await fetch(providerUrl, { ...providerOptions });

      for await (const chunk of upstreamResponse.body!) {
        const text = new TextDecoder().decode(chunk);
        // Normalize to your SSE contract
        const normalized = normalizeProviderChunk(text);
        if (normalized) {
          await writer.write(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
        }
      }

      // Always emit DONE
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (error) {
      // Emit error event before closing
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`)
      );
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } finally {
      await writer.close();
    }
  })();

  // Use waitUntil so the stream outlives the response return
  EdgeRuntime.waitUntil(streamPromise);

  return new Response(readable, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      // Stable metadata headers — set before stream begins
      "X-Router-Model": routerModel,
      "X-Provider": provider,
      "X-Cost-Estimate-USD": costEstimate,
    },
  });
});
```

**Rules:**
- Return the `Response` with the readable stream immediately — don't `await` the stream completion before returning.
- Use `EdgeRuntime.waitUntil(streamPromise)` to keep the function alive while streaming. Without it, the edge function runtime may terminate the background task.
- Set all metadata response headers (model, provider, cost) BEFORE returning the `Response`. Headers cannot be modified after the response is initiated.
- Never buffer the entire upstream response in memory. Process and emit each chunk as it arrives.

---

## 4. Normalization Contract (example_llm_router Pattern)

All upstream provider formats must be normalized to a single event shape before reaching the client. The client parses ONLY the normalized format — it never handles provider-specific shapes.

### Normalized event payload

```typescript
// Content delta — the only event the client renders text from
{ "type": "content_block_delta", "delta": { "text": "..." } }

// Error — emitted before [DONE] on failure
{ "type": "error", "error": "Human-readable error message" }
```

### Provider normalization examples

```typescript
// Anthropic SSE → normalized
// Anthropic emits: data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
function normalizeAnthropicChunk(raw: string) {
  if (!raw.startsWith("data: ")) return null;
  const parsed = JSON.parse(raw.slice(6));
  if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
    return { type: "content_block_delta", delta: { text: parsed.delta.text } };
  }
  return null; // filter out ping/start/stop events
}

// OpenAI SSE → normalized
// OpenAI emits: data: {"choices":[{"delta":{"content":"..."}}]}
function normalizeOpenAIChunk(raw: string) {
  if (!raw.startsWith("data: ") || raw.includes("[DONE]")) return null;
  const parsed = JSON.parse(raw.slice(6));
  const text = parsed.choices?.[0]?.delta?.content;
  if (text) return { type: "content_block_delta", delta: { text } };
  return null;
}
```

**Rules:**
- Normalization happens in the router — never in the frontend.
- Return `null` for non-content events (pings, role assignments, finish_reason). The caller filters nulls before emitting.
- Never forward raw provider errors directly to the client. Normalize to `{ type: "error", error: sanitized_message }`.

---

## 5. Response Headers as API Contract

Metadata about the response (model chosen, provider, cost, routing rationale) travels in response headers, not in the stream body. Headers are available immediately when the fetch resolves — before any stream data arrives.

```typescript
// Client reads headers before processing stream
const response = await fetch("/functions/v1/router", { method: "POST", body, signal: abortController.signal });

if (!response.ok) throw new Error(`Router error: ${response.status}`);

// Read metadata immediately — headers are available now
const model     = response.headers.get("X-Router-Model");
const provider  = response.headers.get("X-Provider");
const cost      = response.headers.get("X-Cost-Estimate-USD");
const rationale = response.headers.get("X-Router-Rationale");

// Then consume stream
for await (const line of readSSELines(response.body!)) { ... }
```

**Rules:**
- The header contract is stable API — treat it like an interface, not an implementation detail. Breaking header names requires a coordinated frontend update.
- A missing header is not an error. Use `response.headers.get("X-Router-Model") ?? "unknown"` — additive headers may not be present on older deployments.
- `EventSource` does NOT expose response headers. Use `fetch` + `ReadableStream` for any SSE endpoint that requires header reading.

---

## 6. Client — Consuming SSE

### Why `fetch` over `EventSource`

| | `EventSource` | `fetch` + `ReadableStream` |
|---|---|---|
| Custom headers (Authorization) | ❌ Not supported | ✅ |
| Access to response headers | ❌ Not supported | ✅ |
| POST body | ❌ GET only | ✅ |
| AbortController support | ❌ Must close manually | ✅ |

Always use `fetch` for authenticated SSE endpoints. `EventSource` is only appropriate for public, GET-based streams.

### Standard client pattern

```typescript
async function* readSSELines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // retain incomplete line
      for (const line of lines) {
        if (line.startsWith("data: ")) yield line.slice(6);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Usage in React component
useEffect(() => {
  const controller = new AbortController();

  (async () => {
    const response = await fetch("/functions/v1/router", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    for await (const data of readSSELines(response.body!)) {
      if (data === "[DONE]") break;
      const event = JSON.parse(data);
      if (event.type === "content_block_delta") {
        setContent(prev => prev + event.delta.text);
      } else if (event.type === "error") {
        setError(event.error);
        break;
      }
    }
  })();

  return () => controller.abort(); // cleanup on unmount
}, []);
```

---

## 7. AbortController & Timeout

```typescript
// User-initiated cancel
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s hard timeout

try {
  const response = await fetch(url, { signal: controller.signal, ... });
  // ... stream consumption
} catch (error) {
  if (error.name === "AbortError") {
    // Map to 504 for consistent error handling
    throw new Error("Stream timeout (504)");
  }
  throw error;
} finally {
  clearTimeout(timeoutId);
}
```

**Rules:**
- Every SSE fetch MUST hold an `AbortController` reference.
- Always call `controller.abort()` in the cleanup function (React `useEffect` return, Vue `onUnmounted`, etc.). Not aborting on unmount leaks the connection and causes state updates on unmounted components.
- `AbortError` must map to HTTP 504 for consistent upstream error handling (example_llm_router invariant).

---

## 8. High-Risk Zones

| Zone | Risk |
|------|------|
| Missing `Content-Type: text/event-stream` | Response not treated as SSE; client reads entire body as text |
| Missing `Cache-Control: no-cache` | Proxy/CDN buffers response; stream appears frozen |
| Buffering entire upstream response | OOM on large responses; latency for the user |
| Missing `[DONE]` sentinel | Client loops forever waiting for end-of-stream |
| Changing normalized event shape | Breaks all frontend stream parsers simultaneously |
| Changing response header names | Breaks frontend metadata display; silent undefined values |
| Using `EventSource` for authenticated routes | Cannot send Authorization header; 401 response silently ignored |
| Not calling `controller.abort()` on unmount | Connection leak; `setState` on unmounted component |


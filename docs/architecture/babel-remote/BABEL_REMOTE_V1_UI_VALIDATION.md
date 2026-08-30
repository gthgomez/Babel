# Babel Remote V1 — UI validation and Android certification

<!--
status: ACTIVE
last_verified: 2026-08-27
-->

This document separates desktop/browser evidence from the physical-device gate.
The deterministic fixture server is read-only and loopback-only; it does not
exercise ChatEngine, a provider, Tailscale, or a real workspace.

## Confidence classes

### A. Automated browser verification

Run from `babel-cli/`:

```powershell
npm run build
npm run test:remote-ui
```

This provides automated evidence that the real Remote PWA shell renders at the
checked viewport sizes, fixture scenarios are reproducible without credentials,
screenshots are emitted
under `artifacts/remote-ui/<scenario>/<viewport>.png`, and the browser harness
checks:

- no unexpected horizontal document overflow;
- visible buttons are at least 40 CSS pixels high and inside the viewport;
- the composer, status indicators, and critical sections have usable size;
- approval visibility and one-time approval interaction;
- long unbroken composer text and long-path content;
- no console errors, uncaught page errors, failed asset requests, or external
  network requests from fixture mode.

The browser matrix intentionally combines all representative widths with a
small set of high-value states instead of creating a large scenario × device
Cartesian product. It covers 320, 360, 384, 390, 412, 430, 800, and 1440 CSS
pixel widths, plus a 390×420 keyboard-like short viewport and an 844×390
landscape viewport. Screenshots are review artifacts and are ignored by Git.

Start the fixture manually when iterating:

```powershell
node .\dist\index.js remote ui-benchmark --port 0 --scenario connected-idle
```

Open the printed `/fixture?scenario=<id>` URL. Available scenarios include
disconnected, connecting, connected-idle, running, streaming, long-transcript,
approval-required, approval-denied, changed-files, large-diff,
verification-pass, verification-failure, verification-partial,
verification-unknown, connection-lost, reconnecting, reconnected,
protocol-error, and long-prompt.

### B. Desktop local end-to-end Remote testing

Run the actual authenticated bridge separately:

```powershell
node .\dist\index.js remote serve --project <workspace-root> --origin https://<tailscale-serve-host>
```

This class can provide evidence for a real browser connection to `babel remote
serve`, bearer authentication, short-lived WebSocket tickets, ADR-010 protocol behavior,
ChatEngine/provider turns, structured transcript events, changed files, diffs,
approvals, and verification. It requires local provider setup when exercising a
model-backed turn. It must remain on the private route: Tailscale Serve is
allowed; Tailscale Funnel and public binding are not.

### C. Physical Android certification

Desktop browser emulation does not prove Android Chrome, PWA installation,
Android IME behavior, touch ergonomics, background lifecycle, cellular routing,
or host sleep/wake recovery. These remain `NOT_VERIFIED` until exercised on the
target phone.

## Physical-device certification checklist

Use a private Tailscale Serve URL and record pass/fail evidence for every row.

| # | Action | Expected behavior | FAIL if |
|---:|---|---|---|
| 1 | Install/open Tailscale on the phone | Device is enrolled and private route is available | Device cannot authenticate or route is public |
| 2 | Verify private host connectivity | Host responds only through the intended private route | No route, Funnel, or public exposure is required |
| 3 | Open the Babel Remote URL | PWA shell loads without console-visible errors | Blank page, asset error, or public endpoint |
| 4 | Authenticate | Token is accepted and is not persisted after reload | Token appears in URL/storage or auth fails unexpectedly |
| 5 | Install PWA to home screen | Standalone launch opens the same Remote shell | Install prompt/launch is broken |
| 6 | Create a thread | New thread becomes active | Wrong workspace or thread isolation failure |
| 7 | Send a prompt | Structured payload arrives once | Corruption, duplicate mutation, or unusable composer |
| 8 | Observe streaming | Progress and current action remain readable | Frozen, clipped, or misleading success state |
| 9 | Stop a turn | Turn enters a clear canceled terminal state | Stop is unreachable or silently resubmits |
| 10 | Trigger/handle approval | Exact action is visible; Allow once/Deny are distinct | Session-wide grant, ambiguous target, or accidental approval |
| 11 | View changed files | File paths wrap and remain readable | Paths clip or cause horizontal page overflow |
| 12 | Inspect diff | Large code remains usable in bounded scroll region | Diff makes the page unusable or loses add/delete cues |
| 13 | Inspect verification | PASS, FAILED, PARTIAL, NOT VERIFIED, and UNKNOWN remain distinct | Unknown/incomplete evidence appears green |
| 14 | Background app | Resume returns to a reconciled state | Silent data loss or duplicate request |
| 15 | Lock phone | Unlock preserves safe session state | Unlock crashes or silently repeats a turn |
| 16 | Switch Wi-Fi → cellular | Private route behavior is explicit | App claims connected without reachability |
| 17 | Temporary network disconnect | Reconnecting is visible and fail-closed | Mutation auto-resubmits or outcome is falsely green |
| 18 | Host sleep | Client shows stale/unavailable state | UI remains misleadingly connected |
| 19 | Host wake | Resume/reconnect recovers thread history | Session cannot recover or duplicates work |
| 20 | Long-running agent task | Activity, approval, and final evidence remain visible | Mobile browser evicts or loses the session silently |
| 21 | Very large prompt paste | Full text remains editable and sends as one payload | Paste truncates, freezes, or simulates keystrokes |
| 22 | Long transcript | Scroll remains responsive and readable | Page memory/layout degrades materially |
| 23 | Large diff | Review remains usable on narrow width | Code is clipped or page overflows |
| 24 | Rotate orientation | Portrait and landscape preserve controls and status | Composer/actions disappear or overlap |

Record the device model, Android version, Chrome version, Tailscale version,
network transition, timestamp, screenshot, and exact failure state for any FAIL.

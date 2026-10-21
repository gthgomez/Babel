# B gzip transport reconciliation (Agent A owns shared decoder)

## Ownership

- **Agent A:** shared `Content-Encoding` decode + `FetchSourceAccessPort` wiring.
- **Agent B:** regression contract tests, optional `responseHeaders` on `admittedHttpGet`, acquisition evidence, PCONT artifact hygiene.

## Shipped on branch `cursor/agent-b-general-fixtures-f617` (not discarded)

| Artifact | Path | Role |
|----------|------|------|
| Optional header capture | `babel-cli/src/research/v2/access/admittedHttpGet.ts` (`responseHeaders?`, `defaultAdmittedHttpGetDispatch`) | Landed @ `7840bff2` / `abe4e5e7` lineage |
| B reconciliation candidate (not imported by port) | `babel-cli/src/research/v2/access/admittedTransportBody.ts` | Reference API: `expandAdmittedTransportBody`, `contentEncodingIncludesGzip` |
| B contract regressions | `babel-cli/src/research/v2/access/admittedTransportBody.regression.test.ts` | Valid gzip HTML + strict UTF-8, malformed gzip, decoded-size limit, cancel |
| Port integration placeholder | `babel-cli/src/research/v2/access/fetchSourceAccessPort.gzip.integration.test.ts` | `todo` until A wires decoder |
| Adapter leak negative | `babel-cli/src/research/v2/profiles/general/generalWebGzipUtf8Admission.negative.integration.test.ts` | Gzip bytes inside admitted payload still fail UTF-8 at read |
| Acquisition replay | `review-artifacts/general-g-l1-attempt2-acquisition-diagnosis.txt` (v2 JSON) | Refetch provenance; original wire bytes unknown |

## Reconcile steps for A

1. Implement shared decoder (may replace or merge `admittedTransportBody.ts`).
2. Wire into `fetchSourceAccessPort.ts` using `response.responseHeaders['content-encoding']`.
3. Point `admittedTransportBody.regression.test.ts` imports at A's module (or re-export from proposal path).
4. Clear `todo` in `fetchSourceAccessPort.gzip.integration.test.ts` and assert port-level gzip HTML admission.

## Explicitly reverted / not published by B

- No `expandAdmittedTransportBody` call in `fetchSourceAccessPort.ts` on this branch (avoid competing transport).

## Epistemic note (G-L1 attempt2)

Live store retained no URL/headers/wire bytes. Bounded replay proves defect class under refetch; not byte-identical original response.

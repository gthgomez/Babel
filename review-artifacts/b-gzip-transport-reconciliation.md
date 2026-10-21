# B gzip transport reconciliation (Agent A owns shared decoder)

## Ownership

- **Agent A:** shared `Content-Encoding` decode, **200_000-byte decoded cap** with truthful truncation + UTF-8-safe bounds (A294 repair; must not fail 218_649-byte python.org HTML class with hard decompress error).
- **Agent B:** contract types/tests, `responseHeaders` on `admittedHttpGet`, acquisition evidence, PCONT hygiene. **No port wiring.**

## A294 review note (refetch evidence)

| Measure | Value | Provenance |
|---------|--------|------------|
| Decompressed HTML length (replay) | **218_649** | `G_L1_ATTEMPT2_REFETCH_DECOMPRESSED_LENGTH` — refetch only; attempt2 store retained **no** original bytes |
| Decode cap | **200_000** | `DEFAULT_MAX_DECODED_ADMISSION_BYTES` |
| Prior failure mode | `ERR_BUFFER_TOO_LARGE` / hard reject | B expects **truncated `ok`** admission + valid UTF-8 |

## B test map (imports Agent A module via `admittedTransportRegressionTarget.ts`)

| File | Runs without A? | Coverage |
|------|-----------------|----------|
| `admittedTransportContract.ts` | types/constants | Cap + refetch length constants |
| `admittedTransportGzip.decoder.regression.test.ts` | **skipped** | Malformed gzip, cancel, tiny maxDecoded, valid gzip UTF-8 |
| `admittedTransportTruncation.reciprocal.test.ts` | partial | **Always:** read-path hash/locator/completeness; **skipped:** 218_649 + multibyte decode |
| `admittedTransportTestFixtures.ts` | fixtures only | Synthetic HTML sizes / UTF-8-safe truncate |
| `generalWebGzipUtf8Admission.negative.integration.test.ts` | yes | Gzip inside admitted payload (leak) |
| `fetchSourceAccessPort.gzip.integration.test.ts` | todo | Port-level after A wires |

## Agent A module candidates (`loadAgentAGzipWireAdmission`)

- `admittedHttpGzipAdmission.js` — preferred export `expandGzipWireAdmission`
- `admittedCompressedHttpBody.js`, `admittedTransportDecode.js` — alternate names

Return shape: `admittedTransportContract.ts` (`GzipWireAdmissionResult`).

## B reconciliation candidate (not wired, not used by tests)

`admittedTransportBody.ts` — reference only for manual diff; **tests do not import it.**

## Shipped transport delta (B)

`admittedHttpGet.ts`: optional `responseHeaders`, `defaultAdmittedHttpGetDispatch` (@ `7840bff2`).

## Epistemic note (G-L1 attempt2)

Live store retained no URL/headers/wire bytes. Bounded replay proves defect class; not byte-identical original response. **No live G-L1** until integrated readiness review.

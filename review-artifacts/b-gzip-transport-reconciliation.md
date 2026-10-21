# A transport integrated @ 06c18d44 (B tests only)

## Runtime

| Field | SHA |
|--------|-----|
| **A transport commit** | `06c18d445f172fca8e03cc0307a0748fbb3d4c3d` |
| **Tree** | `aeacaf9f32e8fb89a307fd8e702654f1b2e2ce9c` |

## Real API (no speculative loaders)

- `decodeAdmittedHttpBody`, `parseContentEncodings`, `AdmittedContentCodingError` — `admittedHttpContentCoding.ts`
- `utf8SafeBytePrefix` — `utf8SafeBytePrefix.ts`
- Port wiring — `admittedHttpGet.ts`, `fetchSourceAccessPort.ts`
- Provenance — `http_content_coding` on `AdmittedContent.provenance`

## B reciprocal tests

| File | Role |
|------|------|
| `fetchSourceAccessPort.decodeTruncation.test.ts` | A port test (218649 / 200000) |
| `fetchSourceAccessPort.gzip.reciprocal.test.ts` | B: valid gzip, trunc, multibyte, malformed, br, cancel, read hash/locator |
| `admittedHttpContentCoding.test.ts` | A unit tests |
| `generalWebGzipUtf8Admission.negative.integration.test.ts` | Gzip bytes inside admitted payload (leak) |

Removed: `admittedTransportRegressionTarget`, `admittedTransportContract`, `admittedTransportBody`, skipped decoder placeholders.

## Epistemic (G-L1)

Attempt2 store retained no original wire bytes. Refetch 218_649 is replay evidence only. Attempt3 preflight prepared; **no live run** until coordinator release.

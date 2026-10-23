# Source provenance

This source package adapts the supplied real-project coding benchmark v1 archive
(SHA-256 `c7c0d258a8cf2ad3bb62299d86569cff47dbcfcb8eb0739b6bdc3cc53f910a9c`).
Operator portability and failure reporting are maintained here as version 1.0.1.
Independent behavioral expectations and reference/control implementations retain
their v1 contracts. Case A version 1.0.1 removes a trailing Markdown hard break
from its prompt header and updates the version and content digests. Cases B/C
retain their original prompt bytes and versions.

| Case | Source and classification |
| --- | --- |
| BRPCB-A | Adapted Babel code-understanding task at `34dd34d9d5bca03550eae9c1e59a73942c932957`. The helper's local import uses `.ts` for native Node loading; small HTML/JS payloads are synthetic. |
| BRPCB-B | Historical Prismatix defect at `150f4446aa7ec001acba3087593a3e6ea38b49d5`, corrected by `b1219549ff6253391b458279c176c39abd4b26ac`. Extracted expiry/parser functions omit unrelated application code. |
| BRPCB-C | Babel's unchanged fuzzy scorer at the same Babel revision, with an authored ranking-feature contract and starter. This is a feature proposal, not a historical defect. |

Babel source Git blobs are `29ca9eff8b411507ae4215b66cd7b08b8135cc6c`
(`remoteUiAssets.ts`), `fddc34c354011a62957ce7d43414716026bab608`
(`remoteUiCachePolicy.ts`), `3fe3d8a295134264ca1982dd3d9cae194ee9ce57`
(`remote-ui/sw.js`), and `4f7c4ebb0d3836b3c16713b84354357c3dd2e669`
(`fuzzy.ts`). The Prismatix baseline and corrected blobs recorded by the original
package are `41103804a52afba76bd3a9f18d4b738880cbdce4` and
`23b3a29a6cffd81376ebb846e0e3faccaa72e4b3`.

Case manifests and the Remote UI workspace's `SOURCE.json` record further
adaptations. Fixtures are bounded extracts; they do not exercise full upstream
builds, production authentication, browser installation, or application integration.
Historical public solutions may be known to an evaluated model.

The workspace/oracle split and separate functional, strict-completion, and
truthfulness axes follow Babel's existing coding-output acceptance fixtures.
Version 1.0.1 includes runnable sources and required notices; archived validation
records, author/reviewer transcripts, and historical tool receipts are excluded.
Use a fresh local validation report to establish behavior on an evaluation host.

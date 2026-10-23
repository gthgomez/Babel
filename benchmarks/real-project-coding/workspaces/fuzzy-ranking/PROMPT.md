# Task: stable ranked candidates

Implement the named export rankCandidates in src/rankCandidates.ts:

    rankCandidates(
      query: string,
      candidates: readonly string[],
      options?: { limit?: number; minScore?: number },
    ): { item: string; score: number; index: number }[]

Use the existing fuzzyScore from src/fuzzy.ts. Preserve all of fuzzyScore's
observable behavior, including its exact scores, case handling, separator
handling, empty-query behavior, and nonmatch behavior.

For a nonempty query, include a candidate only when its fuzzy score is greater
than zero and at least minScore. Return matches by descending score. Ties keep
their original input order. Every result has the original item, score, and
zero-based input index. Duplicate candidate strings remain distinct results.

The query is literal: do not trim whitespace or otherwise normalize it before
passing it to the existing scorer. Only the exact empty string has special
ranking behavior: retain every candidate in original order with score zero,
subject to minScore and limit.

minScore defaults to zero and must be a finite, nonnegative number. limit is
unlimited when omitted and otherwise must be a finite, nonnegative integer.
A limit of zero returns an empty array. Optional fields whose value is
undefined are treated as omitted. Invalid option values must throw RangeError,
even when candidates is empty, the query is empty, or the other option would
produce no results. Fractional minScore values are valid.

Do not mutate candidates or options. Frozen arrays and frozen option objects
must work. Do not add dependencies or use external services.

You may edit or add files under src/. Keep this README, package metadata, and
the supplied tests unchanged. An equivalent implementation is acceptable;
there is no required sorting algorithm or source-file patch layout.

## Verification

Requires Node.js 24.x with native TypeScript support (tested on 24.19.0). No installation is
needed. Run:

    node --test tests/public.test.mjs

Report what you changed and the verification that actually ran. Public tests
are examples and do not exhaust the contract.

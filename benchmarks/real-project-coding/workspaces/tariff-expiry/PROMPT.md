# BRPCB-B: Repair inclusive UTC tariff expiry

Case version: **1.0.0**

A local tariff decision incorrectly treats a rate as expired during its final allowed calendar day. Repair the exported `isPriceExpired` function in `src/model_tariff.ts`.

The module is a small extraction from a real project's historical implementation. It has no dependencies or network behavior. The surrounding registry was removed and its supporting type was narrowed to the one property used here; the historical function bodies were retained.

## Required behavior

`effectiveTo` represents the **last allowed UTC calendar day, inclusive**. For a valid date, the rate remains current throughout that entire day, including its final millisecond. It becomes expired at **exactly 00:00:00.000 UTC on the following day**, and remains expired afterward. Earlier instants remain current. The result must depend on the supplied instant and UTC calendar dates, regardless of the computer's local timezone.

Preserve these existing behaviors:

- An absent or null entry, or an absent, undefined, null, or exactly empty-string `effectiveTo`, has no expiry bound and returns `false`.
- A valid `YYYY-MM-DD` string may contain surrounding whitespace. Trim that whitespace before checking the date.
- Malformed dates, impossible calendar dates, and all other non-string `effectiveTo` values return `true`. In particular, whitespace alone is malformed, and a non-string value must not be coerced into a valid date.
- Date strings must use four digits for the year and two each for month and day. A timestamp or a date with unpadded fields does not satisfy this format.
- Return a boolean. Leave the supplied entry and `now` object unchanged.

Supported valid expiry years are **0100 through 9998**, inclusive. Every scored call supplies a valid, finite JavaScript `Date` as `now`. Validity of expiry years outside the supported range, omitted or invalid `now` values, and entries other than ordinary objects, null, or undefined are outside this case's scope. Exotic accessors and proxies are also outside scope.

## Working area

Edit files only under `src/`. Keep the public export available. You may use any equivalent implementation that satisfies the behavior above; a particular code expression or patch shape is not required.

Do not modify tests, package metadata, this task description, or the license. Do not install packages, fetch external resources, or add network behavior.

## Run the public tests

Use Node.js 24.x (tested with v24.19.0):

```sh
node --test tests/public.test.mjs
```

`npm test` runs the same command. No install step is needed. The starting revision is expected to fail a behavioral regression. The public tests are examples; further evaluation checks the stated contract on other inputs.

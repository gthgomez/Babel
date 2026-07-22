<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this product layer.
-->

# Skill: Google Play Store (v1.0)

**Category:** Mobile
**Status:** Active; requires current primary-source verification
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for Google Play submission, Play Console setup, store-policy review,
release readiness, or billing-distribution questions.

---

## Purpose

Prepare an Android release for Google Play using the target application's actual
configuration and current official Google documentation. This skill is a review
framework, not a snapshot of store policy and not legal advice.

## Required Inputs

Collect evidence before making a compliance claim:

- application ID, release track, and target distribution regions
- `targetSdk`, `minSdk`, Android Gradle Plugin, and NDK versions when applicable
- signed release artifact and signing configuration
- declared permissions and the user-facing features that require them
- billing, analytics, advertising, authentication, and other data-handling SDKs
- privacy policy, Data safety responses, content-rating inputs, and store assets
- current Play Console notices for the target developer account and application

If an input is unavailable, mark the related result `NOT VERIFIED` rather than
inferring it from another project or from an older checklist.

## Primary-Source Currency Check

At the start of every review, verify the applicable requirements in current
Google Play Console Help, Android Developers, and Play policy documentation.
Record the source URL, retrieval date, applicable region or track, and the exact
project evidence used. Treat dates, SDK requirements, asset specifications, and
permitted payment flows as time-sensitive.

## Review Areas

### 1. Platform and artifact compatibility

- Verify the current target API requirement for the intended release track.
- Confirm the accepted artifact format, signing state, version code, and package ID.
- When native libraries are present, inspect ABI coverage and current page-size
  compatibility requirements with artifact-level tooling.
- Test platform behavior changes that apply to the selected `targetSdk`; a
  manifest value alone is insufficient evidence of runtime compatibility.

### 2. Permissions and sensitive capabilities

- Map every declared permission to a shipped feature and an observable user flow.
- Prefer scoped platform APIs when broad storage, media, location, background,
  accessibility, exact-alarm, or special-access permissions are unnecessary.
- Verify whether a declaration, review, prominent disclosure, or consent flow is
  required for each sensitive capability.
- Remove permissions that are unused, obsolete for the target SDK, or unsupported
  by the store listing and privacy disclosures.

Pair with `skill_android_play_store_compliance` for manifest and runtime changes.

### 3. Billing and distribution

- Determine which products, regions, and payment flows are in scope.
- Verify current Google Play Billing requirements and release notes before choosing
  a library version or migration plan.
- Reconcile product identifiers and entitlement behavior among the application,
  backend, and Play Console using project-local evidence.
- Test purchase, cancellation, restoration, pending, offline, and failure paths.

Pair with `skill_google_play_billing` for implementation guidance.

### 4. Data safety and privacy

- Inventory data accessed, collected, transmitted, retained, and shared by both
  application code and transitive SDKs.
- Reconcile that inventory with the privacy policy and Play Console declarations.
- Do not describe an application as offline or data-free solely because its core
  feature runs on-device; inspect every dependency and network path.
- Verify that the published privacy-policy location and in-app access satisfy
  current requirements.

### 5. Store listing and account readiness

- Validate current asset dimensions, formats, counts, and localization rules from
  Play Console rather than copying values from this skill.
- Check that screenshots, descriptions, content ratings, target audience, ads,
  and app-access instructions match shipped behavior.
- Review account-level identity, contact, testing, and declaration requirements
  shown for the target account.

### 6. Integrity and release validation

- Use current platform guidance when selecting integrity or anti-abuse controls.
- Keep server-verifiable decisions off the client when the selected API requires
  server-side verification.
- Exercise the release artifact on representative devices and tracks, then review
  automated pre-launch findings and address applicable failures.

## Evidence Table

For each applicable requirement, produce:

| Field | Required value |
|---|---|
| Requirement | Concise, scoped statement |
| Current source | Official URL and retrieval date |
| Applicability | Region, track, device class, or feature |
| Project evidence | Relative file, artifact, test, or console observation |
| Status | `VERIFIED`, `PARTIAL`, `NOT VERIFIED`, or `NOT APPLICABLE` |
| Follow-up | Owner-neutral capability or evidence needed |

## Hard Rules

1. Current official sources override this review framework when requirements change.
2. Do not publish dated deadlines or version requirements without a cited current source.
3. Do not infer one application's SDKs, permissions, data practices, or migration needs from another application.
4. A successful build does not establish store-policy compliance.
5. Describe unresolved issues as evidence gaps or required capabilities, not assured outcomes.
6. Pair with `skill_android_app_bundle` for release-artifact generation and validation.

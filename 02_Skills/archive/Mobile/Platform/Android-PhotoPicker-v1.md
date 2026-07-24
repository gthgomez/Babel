<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Photo Picker (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_android_permissions`
**Activation:** Load for image selection, photo import, media-picker replacement, or Fire OS /
Amazon image-pick flows.

---

## Purpose

Photo import is now a privacy API choice, not just a UI choice. The correct implementation avoids
storage permissions, handles unsupported picker environments safely, and keeps media selection
lifecycle-safe.

---

## Step 1 — DEFAULT API

For Google Play Android builds, use:
- `ActivityResultContracts.PickVisualMedia`
- `ActivityResultContracts.PickMultipleVisualMedia` when multi-select is required

For Compose:
- `rememberLauncherForActivityResult(...)`

Do not request `READ_MEDIA_IMAGES` just to let the user choose a photo.

---

## Step 2 — AMAZON / FIRE OS RULE

Do not assume the modern picker path is uniformly available on Fire OS environments.

Rule:
- Google Play flavor: `PickVisualMedia` is the default
- Amazon / Fire OS flavor: provide an explicit fallback path, typically `GetContent("image/*")`,
  when picker availability cannot be relied upon

This fallback must be flavor-scoped or availability-scoped. Do not downgrade the Google Play
flavor to the legacy approach.

---

## Step 3 — LIFECYCLE-SAFE USAGE

Rules:
- register the launcher at stable lifecycle scope
- handle `null` result as a normal cancellation path
- copy or consume the returned URI within the intended workflow window
- if long-term document access is needed, move to a SAF flow instead of pretending the picker
  grant is durable

```kotlin
val launcher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.PickVisualMedia()
) { uri: Uri? ->
    if (uri != null) {
        viewModel.onPhotoPicked(uri)
    }
}
```

---

## Step 4 — COMMON FAILURE CASES

| Failure | Why it happens | Prevention |
|---------|----------------|-----------|
| Picker works on one device, fails on Fire OS | no fallback path | provide availability- or flavor-scoped fallback |
| App requests storage permission unnecessarily | legacy mental model | use picker without broad media permission |
| Selected URI fails later | temporary access not persisted | consume promptly or switch to SAF when durable access is required |
| UI crashes on cancellation | `null` not handled | treat `null` as user cancel |

---

## Step 5 — POLICY / COMPLIANCE NOTES

- Prefer the Photo Picker for privacy-sensitive media selection.
- Avoid broad media permissions when the picker satisfies the feature.
- Do not claim persistent library access if the feature only needs user-selected media.

---

## Hard Rules

1. Use `PickVisualMedia` by default for Google Play photo selection.
2. Do not request `READ_MEDIA_IMAGES` only to open a picker.
3. Provide an explicit Amazon / Fire OS fallback when picker availability is not reliable.
4. Always handle cancellation and temporary URI access correctly.
5. Do not use the photo picker as a substitute for durable document access workflows.

# Skill: Android Testing Obligation (v1.0)

**Status:** Active
**Activation:** Default for Android/Kotlin work.

---

## Rule

Changed Android behavior needs proof. Name the smallest adequate verification path: unit/ViewModel,
screenshot, instrumented/platform, build/static, or manual/device. Never claim tests passed without
evidence. Report skipped or unavailable paths and reasons. Copy/comment-only: say no behavior
changed. Use `skill_android_test_enforcement_deep` for CI gates, test matrices,
screenshot/instrumented obligations, billing/platform/API behavior, or release blockers.

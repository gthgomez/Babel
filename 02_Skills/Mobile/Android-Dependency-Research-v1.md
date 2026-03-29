<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Dependency Research (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load before specifying any third-party Gradle dependency whose exact Maven
coordinates, version, or artifact name are not already verified in the current project.
Also load when a build fails with "Could not find" or a class is "Unresolved" despite the
dependency being declared.

**Research basis:** Derived from a real debugging session (2026-03-28) where the RC
`purchases-amazon` artifact name, a runtime-scope compile gap, and a major-version API
rename caused three sequential build failures that each required a separate investigation round.
Each failure was preventable with upfront Maven metadata inspection.

---

## Purpose

Declaring a dependency in Gradle is not the same as verifying it compiles. The three most
common silent failures:

1. **Wrong artifact name or version** — The library was renamed, version doesn't exist, or
   is only available on a custom Maven repo not in `settings.gradle`.
2. **Runtime-scope compile gap** — A transitive dependency is declared `runtime` scope in
   the library's POM or Gradle module metadata. Classes from it are available at runtime but
   absent from the compile classpath — unresolved reference errors at build time.
3. **Major-version API break** — A version bump changes package names, removes methods,
   or restructures the callback model. Code that compiled against v8 fails to compile
   against v9 without a migration step.

This skill provides the verification protocol to catch all three before writing implementation code.

---

## Step 1 — VERIFY ARTIFACT EXISTS AND FIND CORRECT COORDINATES

Before writing a single `implementation(...)` line, confirm the artifact resolves.

**Maven Central metadata check (fastest):**

```bash
# Replace group path slashes with '/' and check the metadata XML
curl -s "https://repo1.maven.org/maven2/<group/path>/<artifact>/maven-metadata.xml"
# Example:
curl -s "https://repo1.maven.org/maven2/com/revenuecat/purchases/purchases-store-amazon/maven-metadata.xml"
```

If the response is 404: the artifact does not exist on Maven Central. Check for:
- Renamed artifact (search the library's GitHub releases or docs)
- Custom Maven repo required in `settings.gradle`
- Wrong group ID

**GitHub releases API (find correct latest version):**

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/releases/latest" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('tag_name',''))"
```

**Maven Central search API (list all artifacts in a group):**

```bash
curl -s "https://search.maven.org/solrsearch/select?q=g:<group.id>&rows=20&wt=json" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(doc['a'], doc.get('latestVersion','')) for doc in d['response']['docs']]"
```

**Rule:** Never guess an artifact name. Artifact names change between major versions.
Verify the exact name + version in the Maven metadata before adding to `libs.versions.toml`.

---

## Step 2 — INSPECT POM SCOPE AND GRADLE MODULE METADATA

A dependency resolving at runtime is not the same as being on the compile classpath.

### Maven POM scope semantics

| POM scope | Gradle equivalent | On compile classpath? | On runtime classpath? |
|-----------|-------------------|-----------------------|-----------------------|
| `compile` | `api` or `implementation` | Yes | Yes |
| `runtime` | `runtimeOnly` | **No** | Yes |
| `provided` | `compileOnly` | Yes | No |

**Check the POM:**

```bash
curl -s "https://repo1.maven.org/maven2/<group/path>/<artifact>/<version>/<artifact>-<version>.pom" \
  | grep -A3 "<dependency>"
```

If a dependency you need is listed with `<scope>runtime</scope>`: its classes are **absent
from your compile classpath**. You will get `Unresolved reference` errors at build time.
Fix: add that dependency explicitly as `implementation(...)` alongside the declaring library.

### Gradle module metadata (more authoritative than POM)

Gradle prefers `.module` files over `.pom`. Check the API variant — only API-variant deps
are available at compile time:

```bash
curl -s "https://repo1.maven.org/maven2/<group/path>/<artifact>/<version>/<artifact>-<version>.module" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
for v in d.get('variants',[]):
    if 'Api' in v['name']:
        print('API (compile):', [dep['module'] for dep in v.get('dependencies',[])])
    elif 'Runtime' in v['name']:
        print('Runtime only:', [dep['module'] for dep in v.get('dependencies',[])])
"
```

Deps in the API variant → available at compile time.
Deps in the Runtime variant only → runtime-only, add explicitly if you import their classes.

**Real example (RevenueCat v9):**
- `purchases-store-amazon` API variant: only `kotlin-stdlib`
- `purchases-store-amazon` Runtime variant: `purchases` (RC core), `amazon-appstore-sdk`
- Result: `Purchases`, `CustomerInfo`, `PurchaseParams` from `purchases` were all unresolved
  until `purchases` was added explicitly as `amazonImplementation`.

---

## Step 3 — CHECK MAJOR-VERSION API BREAKS

Never assume the API used in documentation or a previous implementation is still valid
after a major version bump. Each major version increment may:

- rename or remove classes
- change method signatures or callback styles
- rename artifacts (e.g., `purchases-amazon` → `purchases-store-amazon` in RC v9)
- restructure package names (e.g., `models.PurchaseParams` → `PurchaseParams` in RC v9)
- change from lambda callbacks to interface callbacks

**Checklist before implementing against a new major version:**

1. Find the migration guide: check `CHANGELOG.md` in the GitHub repo and search for `## x.0.0`
2. Grep the target source for the class/method you intend to use:
   ```bash
   curl -s "https://api.github.com/repos/<owner>/<repo>/git/trees/main?recursive=1" \
     | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f['path']) for f in d.get('tree',[]) if 'ClassName.kt' in f['path']]"
   ```
3. Fetch the source to confirm the current method signature before writing any call site:
   ```bash
   curl -s "https://raw.githubusercontent.com/<owner>/<repo>/main/<path/to/File.kt>" \
     | grep -A5 "fun methodName"
   ```
4. Check for coroutine extension files (`coroutinesExtensions.kt`, `CoroutinesExtensionsCommon.kt`)
   — these often contain the clean `suspend`/`await*` API that replaces old callbacks.

**Real example (RevenueCat v8 → v9):**
- `purchaseWith(PurchaseParams, onError, onSuccess)` → removed; replaced by `awaitPurchaseResult(PurchaseParams): Result<PurchaseResult>`
- `getCustomerInfo { result, error -> }` lambda → removed; replaced by `awaitCustomerInfo(): CustomerInfo`
- `getOfferings { result, error -> }` lambda → removed; replaced by `awaitOfferings(): Offerings`
- `com.revenuecat.purchases.models.PurchaseParams` → moved to `com.revenuecat.purchases.PurchaseParams`

---

## Step 4 — SETTINGS.GRADLE REPO DECLARATION

If an artifact is not on Maven Central or Google Maven (`dl.google.com`), a custom
repository must be declared in `settings.gradle.kts` under `dependencyResolutionManagement`.

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { url = uri("https://custom.repo.url/maven2") }  // add only if needed
    }
}
```

**Rule:** `FAIL_ON_PROJECT_REPOS` mode (the AGP default) makes the build fail if a repo
is declared inside `app/build.gradle.kts` instead of `settings.gradle.kts`. Check the
library's README for any custom repo requirement before adding the dependency.

---

## Pre-Implementation Checklist

Before writing implementation code that depends on a new third-party library:

```
□ Artifact coordinates verified: curl Maven metadata XML → 200 response, not 404
□ Correct version found: GitHub releases API or Maven metadata <release> tag
□ POM + Gradle .module scopes inspected: any runtime-only deps needed explicitly?
□ Major-version API confirmed: checked source or CHANGELOG for breaking changes
□ Coroutine extensions checked: is there a cleaner await* API than raw callbacks?
□ Custom repo requirement checked: does settings.gradle.kts need a maven { url } entry?
□ libs.versions.toml updated with verified coordinates and version
```

---

## Hard Rules

1. Never assume an artifact name is stable across major versions. Verify via Maven metadata
   before declaring in `libs.versions.toml`.
2. Never assume a transitive dependency is on the compile classpath. If you import classes
   from it, check whether it appears in the declaring library's API variant or runtime variant.
   Add it explicitly if runtime-only.
3. Never copy-paste a `build.gradle` snippet from docs without verifying the version exists.
   Docs lag behind releases. Confirm with `maven-metadata.xml` or the GitHub releases API.
4. Never implement against a new major version without checking the changelog and at least
   one method signature in the current source. API surface changes between major versions
   are common and rarely well-publicized.
5. Never add a custom Maven repo URL without confirming it is the official source for that
   library. Custom repos can serve malicious artifacts at the same coordinates.

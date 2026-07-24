<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Jetpack Compose for TV Focus & Components (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Last Verified:** 2026-06-26
**Activation:** Load for Jetpack Compose tasks targeting Android TV, TV Material3 components, custom `TvLazyRow`/`TvLazyColumn` structures, or TV focus restoration states.

---

## Purpose

Standard Android Compose components (Material3) are designed for touch input. Loading them on Android TV projects results in non-functional focus states, missing visual D-pad selections, and lost scroll indices when navigating list items.

This skill governs the correct implementation of TV-specific Jetpack Compose layout engines, custom focus requesters, and 10-foot visual styling rules.

---

## Step 1 — TvFocusRequester & Focus Restoration

TV screens must boot with a default focused element, and scroll views must preserve the last focused index when the user returns from nested navigation paths.

### Rules
1. **Initial Focus Request:** Always associate a `FocusRequester` with the primary action element and trigger it inside a `LaunchedEffect`:
   ```kotlin
   import androidx.compose.runtime.LaunchedEffect
   import androidx.compose.runtime.remember
   import androidx.compose.ui.focus.FocusRequester
   import androidx.compose.ui.focus.focusRequester
   import androidx.tv.material3.Button

   @Composable
   fun TvWelcomeScreen(onStart: () -> void) {
       val focusRequester = remember { FocusRequester() }

       Button(
           onClick = onStart,
           modifier = Modifier.focusRequester(focusRequester)
       ) {
           Text("Start Generation")
       }

       LaunchedEffect(Unit) {
           focusRequester.requestFocus() // Steer initial focus on boot
       }
   }
   ```
2. **Scroll Focus Restoration:** Utilize Compose TV's lazy list restoration states to prevent focus from jumping back to index `0` when scrolling back into views:
   ```kotlin
   import androidx.tv.foundation.lazy.list.TvLazyRow
   import androidx.tv.foundation.lazy.list.rememberTvLazyListState

   @Composable
   fun MovieRibbon(movies: List<Movie>) {
       val listState = rememberTvLazyListState()

       TvLazyRow(
           state = listState,
           pivotVal = PivotVal(0.5f) // Keep focused item centered in row viewport
       ) {
           items(movies.size) { index ->
               MovieCard(movie = movies[index])
           }
       }
   }
   ```

---

## Step 2 — TV Card & Button Components

Never use mobile Compose material design components. Android TV projects must import strictly from `androidx.tv.material3` to support native remote control select and click sequences.

### Rules
1. **Material3 TV Card Styling:** Configure `CardDefaults` to animate size, border, and elevation changes automatically upon focus:
   ```kotlin
   import androidx.tv.material3.Card
   import androidx.tv.material3.CardDefaults
   import androidx.tv.material3.ExperimentalTvMaterial3Api

   @OptIn(ExperimentalTvMaterial3Api::class)
   @Composable
   fun MovieCard(movie: Movie) {
       Card(
           onClick = { /* Navigate to player */ },
           scale = CardDefaults.scale(focusedScale = 1.08f), // Grow on focus
           border = CardDefaults.border(
               focusedBorder = Border(
                   borderStroke = BorderStroke(2.dp, Color.White),
                   shape = RoundedCornerShape(8.dp)
               )
           ),
           glow = CardDefaults.glow(focusedGlow = Glow(Color.Blue.copy(alpha = 0.4f), 10.dp))
       ) {
           MovieBanner(movie)
       }
   }
   ```

---

## Step 3 — D-pad Banner Carousel

Carousels on TV must auto-scroll smoothly but yield focus lock immediately when the user navigates into the carousel using the remote.

### Rules
1. **Carousel Focus Lock:** Use TV Compose `Carousel` to manage inner slides and bind slide navigation to remote clicks:
   ```kotlin
   import androidx.tv.material3.Carousel
   import androidx.tv.material3.CarouselState

   @Composable
   fun PromoBannerCarousel(promos: List<Promo>) {
       val carouselState = remember { CarouselState() }

       Carousel(
           itemCount = promos.size,
           state = carouselState,
           autoScrollDurationMillis = 5000 // 5 seconds auto-scroll
       ) { activeIndex ->
           Box(modifier = Modifier.fillMaxSize()) {
               PromoContent(promos[activeIndex])
           }
       }
   }
   ```

---

## Step 4 — Spatial Focus Outlines (A11y)

Ensure high-contrast feedback configurations for layouts viewed from 10 feet away.

### Rules
1. **Combined Visual States:** Never rely solely on color indicators. Focused items must feature a scale transform (typically `1.05f` to `1.1f`) and a solid contrasting border outline.
2. **Safe-Area Layout Spacing:** Provide generous margins (minimum `24.dp` horizontal and vertical) on screen edges to prevent text from clipping on TVs with overscan bezels.

---

## Hard Rules

1. **Never import mobile Material3 components** (`androidx.compose.material3.*`) into Android TV screens. Always use `androidx.tv.material3.*`.
2. **Never configure infinite loop scroll views** without a custom focus requester block, or D-pad navigation will get stuck in focus traps.
3. **Always trigger `requestFocus` asynchronously** inside a `LaunchedEffect` to avoid blocking compose pass measurement cycles.
4. **Never use static pixel/dp coordinates** for full-screen carousels. Always leverage `Modifier.fillMaxSize()`.
5. **Always test D-pad navigation pathways** recursively to ensure no elements are unreachable.

---

## Boundaries — Do Not Overstep

- This skill defines Jetpack Compose TV-specific UI, focus, and component rules. It does not replace Google's official Android Developer TV guides or core Kotlin coroutines patterns.
- Target library compatibility must align with `androidx.tv:tv-foundation` and `androidx.tv:tv-material` version bindings.

---

## Failure Behavior of This Skill

- **Focus skips elements in lazy rows:** Verify that elements inside rows have clickable properties set, or that `FocusRequester` bindings do not conflict.
- **D-pad navigation fails to trigger item click:** Verify that `androidx.tv.material3.Card(onClick = ...)` or `Button` is used instead of mobile layouts with raw gesture modifiers.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on focus state changes, overscan margins, or TV library configurations.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for verifying kotlin structures.
- `skill_android_jni_llama` (`Mobile/Platform/Android-Native-JNI-Llama-v1.md`) — for thread hooks context.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 3 TV Integration (Compose TV).

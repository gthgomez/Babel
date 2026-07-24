<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: GSAP Animation & Static Localization (v1.0)

**Category:** UI
**Status:** Active
**Pairs with:** `domain_swe_frontend`
**Last Verified:** 2026-06-26
**Activation:** Load for tasks implementing web animations (GSAP, ScrollTrigger), multi-language layout transitions (RTL/LTR), or localized text spacing audits.

---

## Purpose

Web animations using GreenSock (GSAP) frequently conflict with static localization setups. Text length varies up to 40% across languages (e.g. German vs. English), causing hardcoded animation offsets to clip text or cause layout breaks. Furthermore, direction changes (RTL for Arabic/Hebrew) reverse coordinate systems, and improper React integration of ScrollTriggers creates memory leaks and Cumulative Layout Shift (CLS).

This skill governs localized animation coordinates, responsive text scaling, and ScrollTrigger lifecycle management.

---

## Step 1 — ScrollTrigger & Timeline Hydration (React Lifecycle)

GSAP timelines must be bound to the React component lifecycle. Creating animations directly on load without cleanup results in multiple active triggers, memory leaks, and broken scrolls on route changes.

### Rules
1. **The GSAP Context Wrapper:** Always wrap timeline initialization in a `gsap.context()` inside a `useLayoutEffect` (or `useEffect` if SSR-safed) and return its revert function:
   ```tsx
   import { useLayoutEffect, useRef } from 'react';
   import { gsap } from 'gsap';
   import { ScrollTrigger } from 'gsap/ScrollTrigger';

   gsap.registerPlugin(ScrollTrigger);

   export function AnimatedHeader() {
       const containerRef = useRef<HTMLDivElement>(null);

       useLayoutEffect(() => {
           // Create context bound to this component
           const ctx = gsap.context((self) => {
               // Scope queries strictly to self.selector to prevent selecting outer DOM nodes
               const title = self.selector('.title');
               
               gsap.timeline({
                   scrollTrigger: {
                       trigger: containerRef.current,
                       start: 'top center',
                       end: 'bottom center',
                       scrub: true
                   }
               })
               .from(title, { y: 50, opacity: 0 });

           }, containerRef); // Scope selector to containerRef

           return () => {
               ctx.revert(); // Automatically kills all timelines and ScrollTriggers inside context
           };
       }, []);

       return (
           <div ref={containerRef} style={{ minHeight: '100vh' }}>
               <h1 className="title">Localized Title</h1>
           </div>
       );
   }
   ```

---

## Step 2 — RTL/LTR Direction Adapters

RTL languages (Arabic, Hebrew) mirror horizontal layouts. Hardcoding absolute animation translations (e.g. animating from left-to-right via positive `x` coordinates) will break reading flows and overlap menus.

### Rules
1. **Dynamic Direction Vectors:** Calculate horizontal translation offsets relative to the HTML document direction:
   ```typescript
   const isRTL = document.documentElement.dir === 'rtl' || document.dir === 'rtl';
   
   // If RTL, negate the translate value to slide from the opposite side
   const slideDirection = isRTL ? -1 : 1;
   const startingX = 150 * slideDirection;

   gsap.from('.box', {
       x: startingX,
       opacity: 0,
       duration: 1.0
   });
   ```
2. **Text Alignment Transforms:** When animating text block containers, animate `transformOrigin` based on text alignment:
   ```typescript
   gsap.from('.text-container', {
       transformOrigin: isRTL ? 'right center' : 'left center',
       scaleX: 0
   });
   ```

---

## Step 3 — Localized Text Overflow & Wrap Protection

German, French, and Russian words are significantly longer than English equivalents. Text wrapping mid-animation causes unexpected line breaks and shifts container heights.

### Rules
1. **Avoid Hardcoded Width Limits:** Animated text elements must not use static `width` dimensions. Always specify `min-width: min-content` or dynamic flex layouts:
   ```css
   /* CSS */
   .animated-label {
       white-space: nowrap; /* Prevent line breaks during scale/slide */
       min-width: max-content;
   }
   ```
2. **Flexible Container Animation:** If an animation changes container sizes, animate layout constraints like `max-height` or use GSAP's `Flip` plugin rather than hardcoding static pixel height boundaries.

---

## Step 4 — Flash of Unstyled Content (FOUC) & CLS Prevention

React's initial paint occurs before GSAP applies CSS styles, causing elements to flicker in their final state before snapping to their animated start state.

### Rules
1. **Apply Initial Visibility Bounds:** Set CSS rules to hide animated components on render, and let GSAP reveal them:
   ```css
   /* CSS */
   .gsap-reveal {
       opacity: 0;
       visibility: hidden;
   }
   ```
2. **Auto-Reveal in Timeline:** Let GSAP remove the visibility guard:
   ```typescript
   gsap.to('.gsap-reveal', {
       autoAlpha: 1, // Combines opacity: 1 and visibility: visible
       duration: 0.5
   });
   ```

---

## Hard Rules

1. **Always clean up GSAP timelines** on component unmount by returning `ctx.revert()` in React hooks.
2. **Never hardcode direction values** (`left`, `right`, positive/negative `x` vectors) for horizontal animations without checking the document direction context.
3. **Never apply fixed width/height constraints** to elements containing localized text that are animated.
4. **Always use `autoAlpha`** instead of raw `opacity` to prevent elements with opacity 0 from blocking mouse clicks/interactions.
5. **Never run ScrollTrigger loops** on windows without setting a throttle/debounce callback.

---

## Boundaries — Do Not Overstep

- This skill defines GSAP animation lifecycle and localization layout rules. It does not replace the official GSAP API documentation, WebGL performance rules, or CSS direction specifications.
- Browser compatibility checks must target standard modern engines supporting CSS variables and flex/grid direction properties.

---

## Failure Behavior of This Skill

- **Scroll animations lock up or duplicate on navigation:** Halt. Check for missing unmount cleanup hooks. Ensure `ctx.revert()` is called.
- **Text overflows or wraps in German translation:** Halt. Ensure no fixed width values are defined on the text container. Change container settings to `max-content` or wrap behaviors.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on scroll triggers, directional variables, or layout wrapping rules.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for compiler validation.
- `skill_react_nextjs` (`Framework/React-NextJS-v2.md`) — for client hydration checks.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 3 UI Integration (GSAP/Localization).

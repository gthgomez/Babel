<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

---
id: skill_motion_kinetic_ui
name: Motion & Kinetic UI
category: UI
status: active
last_verified: 2026-06-02
---

# Skill: Motion & Kinetic UI (v1.1)

Guidelines for implementing "alive" and immersive user interfaces using modern Motion for React (`motion/react`) or standard CSS transitions where optimized.

## 1. Core Kinetic Rules

Every dynamic or interactive UI animation must adhere to these strict conditional rules:

- `[Shared Elements Transition]: Apply the layout and layoutId props from motion/react when elements scale or animate across different positions — To guarantee smooth visual continuity and eliminate layout shifting.`
- `[Tactile Gestures]: Prioritize whileHover, whileTap, and whileDrag gestures from motion/react for button and card interactions — To provide immediate, high-fidelity tactile feedback that makes the interface feel alive.`
- `[Scroll-Based Parallax]: Leverage the useScroll and useTransform hooks from motion/react for progress bars or narrative parallax effects — To synchronize interactive animations directly with the user's scroll progression.`
- `[Unmounting Elements]: Wrap conditional elements in <AnimatePresence> from motion/react and set exit animations — To allow elements to animate gracefully out of the DOM before they are unmounted.`
- `[Accessibility Constraints]: Enforce useReducedMotion hook from motion/react or CSS media queries for heavy animations — To respect prefers-reduced-motion settings and support users with motion sensitivities.`
- `[Performance Optimization]: Target only GPU-accelerated composited properties like scale, translate, and opacity for animations while avoiding animating layout properties like width, height, and top — To prevent expensive browser reflows and guarantee 60/120fps rendering.`
- `[Animation Timing]: Limit UI feedback animations to 100ms-300ms and restrict longer narrative sequences to <=500ms — To maintain snappy responsiveness and prevent user flow fatigue.`
- `[Kinetic Physics Dynamics]: Configure type: "spring" with precise stiffness and damping coefficients rather than static cubic-bezier easings — To produce organic, physical responses that mimic realistic inertia.`
- `[Grid and List Entrances]: Apply staggered animation variants with staggerChildren from motion/react — To produce structured, rhythmic cascading transitions across child items.`
- `[Interactive micro-interactions]: Introduce subtle, low-frequency infinite loops like a gentle pulse or breathing motion — To guide user attention toward call-to-actions without cluttering the screen.`

---

## 2. Kinetic Principles (2026)

- **Physics over Easing**: Standard cubic-bezier easing feels mechanical. Real-world physical objects have mass, friction, and tension. Spring physics must be the default for UI motion.
- **Staggered Orchestration**: When lists or grids load, having all items pop in at once creates visual cognitive load. A fast, staggered delay sequence creates a high-fidelity "fluid waterfall" feel.
- **Micro-animations**: Subtle breathing states draw visual attention. However, never loop large scaling changes or rapid position changes, as they distract the eye from the main tasks.

---

## 3. Verification & Compliance Checklist

- Verify that animations do not drop frames on low-power mobile CPU configurations.
- Ensure that setting `prefers-reduced-motion: reduce` at the operating system level successfully bypasses heavy spring animations.
- Check that `<AnimatePresence>` handles multiple concurrent exit animations without layout glitches or "flickering" layout shifts.

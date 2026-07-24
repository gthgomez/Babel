<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Phaser 3 & Next.js Game Hydration (v1.0)

**Category:** Game
**Status:** Active
**Pairs with:** `domain_web_rpg`
**Last Verified:** 2026-06-26
**Activation:** Load for Next.js or React tasks implementing Phaser 3 game loops, HTML5 canvas rendering, dynamic viewport resizing, or React-Phaser event bridging.

---

## Purpose

Integrating Phaser 3 inside a modern Next.js React codebase introduces strict architectural conflicts. Next.js runs Server-Side Rendering (SSR) passes where the global `window` object is unavailable, triggering crash-on-load bugs if Phaser classes are imported statically. Additionally, managing canvas lifecycle states (destroying game loops during React route transitions) and syncing UI overlay state (React state vs. Phaser game memory) require clear event-driven bridges.

This skill governs client-only instantiation, canvas lifecycle cleanup, and state synchronization between React and Phaser.

---

## Step 1 — SSR-Safe Client-Only Canvas Instantiation

Phaser references `window` and `document` variables immediately upon import. You must dynamic-import Phaser or wrap instantiation so it runs strictly on the client side.

### Rules
1. **Dynamic Import Wrapper:** Import Phaser asynchronously within React's `useEffect` or use Next.js `dynamic` with `ssr: false`:
   ```tsx
   import { useEffect, useRef } from 'react';

   export function GameContainer() {
       const parentRef = useRef<HTMLDivElement>(null);
       const gameRef = useRef<any>(null);

       useEffect(() => {
           // Ensure initialization only runs on the client side
           const initPhaser = async () => {
               const Phaser = (await import('phaser')).default;
               const { MainScene } = await import('../scenes/MainScene');

               const config: Phaser.Types.Core.GameConfig = {
                   type: Phaser.AUTO,
                   parent: parentRef.current || undefined,
                   width: 800,
                   height: 600,
                   scene: [MainScene],
                   physics: {
                       default: 'arcade',
                       arcade: { debug: false }
                   }
               };

               gameRef.current = new Phaser.Game(config);
           };

           initPhaser();

           return () => {
               // Cleanup Phaser instance when React unmounts
               if (gameRef.current) {
                   gameRef.current.destroy(true);
                   gameRef.current = null;
               }
           };
       }, []);

       return <div ref={parentRef} id="game-parent" style={{ width: '100%', height: '100%' }} />;
   }
   ```

---

## Step 2 — Next.js Static Asset Loading

Phaser loaders fetch assets via standard XMLHttpRequests. Incorrect relative paths cause asset loading to fail (resulting in green placeholder boxes) when deployed to nested Next.js routes.

### Rules
1. **Reference Public Root Paths:** Store all sprite sheets, audio files, and maps inside Next.js `/public/` directory (e.g. `/public/assets/images/sprite.png`).
2. **Absolute Relative Loading:** Prefix paths in Phaser loader calls with a leading slash `/` to guarantee correct routing from any page depth:
   ```typescript
   import Phaser from 'phaser';

   export class MainScene extends Phaser.Scene {
       constructor() {
           super('MainScene');
       }

       preload() {
           // Use leading slash to point directly to /public/assets/
           this.load.image('player', '/assets/images/player.png');
           this.load.spritesheet('enemy', '/assets/assets/enemy.png', {
               frameWidth: 32,
               frameHeight: 32
           });
       }
   }
   ```

---

## Step 3 — React-Phaser State Bridge

Avoid polling Phaser scene state inside React render cycles. Use a shared Event Bus / Custom Event Emitter to push state changes to React only when they occur.

### Rules
1. **The Shared Event Bus:** Create a central event emitter to bridge the boundary:
   ```typescript
   // utils/EventBus.ts
   import Phaser from 'phaser';
   export const EventBus = new Phaser.Events.EventEmitter();
   ```
2. **Emitting from Phaser Scenes:**
   ```typescript
   export class MainScene extends Phaser.Scene {
       updatePlayerHealth(hp: number) {
           this.playerHealth = hp;
           // Emit change to the React UI
           EventBus.emit('player-hp-changed', hp);
       }
   }
   ```
3. **Listening in React Hooks:** Use local state and update it upon receiving event notifications:
   ```tsx
   import { useEffect, useState } from 'react';
   import { EventBus } from '../utils/EventBus';

   export function HudOverlay() {
       const [hp, setHp] = useState(100);

       useEffect(() => {
           const onHpChanged = (newHp: number) => {
               setHp(newHp);
           };

           EventBus.on('player-hp-changed', onHpChanged);
           return () => {
               EventBus.off('player-hp-changed', onHpChanged);
           };
       }, []);

       return (
           <div style={{ position: 'absolute', top: 20, left: 20, color: 'white' }}>
               <text>Health: {hp}</text>
           </div>
       );
   }
   ```

---

## Step 4 — Viewport Scale Manager

Phaser's canvas must scale responsively to fit various screen sizes without distorting assets.

### Rules
1. **Dynamic Scaling Configuration:** Configure Phaser's Scale Manager to automatically fit the parent div container while maintaining aspect ratios:
   ```typescript
   const config: Phaser.Types.Core.GameConfig = {
       scale: {
           mode: Phaser.Scale.FIT,
           autoCenter: Phaser.Scale.CENTER_BOTH,
           width: 1280, // Game logical resolution
           height: 720,
           parent: 'game-parent'
       }
   };
   ```
2. **Container Resize Observers:** Ensure the parent HTML wrapper element has explicitly set CSS dimensions (e.g. `height: 100vh` or absolute dimensions) to allow the Scale Manager to compute width/height ratios correctly.

---

## Hard Rules

1. **Never instantiate a Phaser Game object** outside React's `useEffect` or client-only render checks.
2. **Always call `game.destroy(true)`** when unmounting the React container. Skipping this causes canvas and WebGL memory leaks that crash the user's browser.
3. **Never reference assets relative to the current JS file location.** Always use leading slash paths referring to the Next.js `public` directory.
4. **Never update React states** in high-frequency loops (e.g., inside Phaser scene's `update()` method running at 60 FPS). Limit UI emissions to specific trigger actions.
5. **Always disable server-side rendering** for the component that holds the game canvas.

---

## Boundaries — Do Not Overstep

- This skill details Phaser 3 and Next.js integration mechanics. It does not replace the Phaser API documentation, physics engine specifications (Arcade, Matter.js), or React hook rules.
- Viewport scaling must support default aspect configurations (16:9, 4:3) and avoid pixelated stretch distortions.

---

## Failure Behavior of This Skill

- **Next.js build fails with `ReferenceError: window is not defined`:** Search for static imports of Phaser. Convert the component to load via dynamic imports with `ssr: false`.
- **Browser memory usage grows on page transitions:** Ensure `game.destroy(true)` is called in the `useEffect` cleanup return. Check for unbound EventBus listeners.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on client-side loading checks, EventBus listeners, or canvas scaling properties.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for react/typescript hooks verification.
- `skill_react_nextjs` (`Framework/React-NextJS-v2.md`) — for Next.js SSR hydration structures.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 2 Web Integration (Phaser/Next.js).

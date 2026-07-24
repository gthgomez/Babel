<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: React Native TV Focus & Spatial Navigation (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_react_native`
**Last Verified:** 2026-06-26
**Activation:** Load for React Native tasks targeting Android TV, Apple TV, spatial navigation, remote D-pad input handlers, or focus trap elements.

---

## Purpose

TV platforms rely on directional navigation (D-pad Up/Down/Left/Right) rather than touch. React Native apps on TV frequently suffer from focus loss (the focused state disappears), spatial traps (focus cannot exit a grid or sidebar), and performance degradation in virtualized lists when the D-pad is held down.

This skill governs focus management, remote control key handling, and list navigation performance on TV platforms.

---

## Step 1 — Spatial Navigation & Focus Traps

A spatial layout must guide the D-pad engine so that focus moves logically between headers, sidebars, grids, and details.

### Rules
1. **Focusable Containers:** Explicitly declare focusable elements using `TouchableHighlight` or `Pressable` with `focusable={true}`:
   ```tsx
   import { Pressable, StyleSheet, Text, View } from 'react-native';

   interface TvButtonProps {
       label: string;
       onPress: () => void;
   }

   export function TvButton({ label, onPress }: TvButtonProps) {
       return (
           <Pressable
               focusable={true}
               onPress={onPress}
               style={({ focused }) => [
                   styles.button,
                   focused && styles.buttonFocused
               ]}
           >
               <Text style={styles.text}>{label}</Text>
           </Pressable>
       );
   }
   ```
2. **Focus Guides & Traps:** Use `TVFocusGuideView` to group components and control focus search direction, preventing focus from escaping to unrelated sidebars:
   ```tsx
   import { TVFocusGuideView } from 'react-native';

   // Lock focus movement strictly within this horizontal ribbon
   <TVFocusGuideView trapFocusLeft={true} trapFocusRight={true} destructuring={true}>
       <View style={styles.ribbon}>
           <TvButton label="Item 1" onPress={handlePress} />
           <TvButton label="Item 2" onPress={handlePress} />
       </View>
   </TVFocusGuideView>
   ```

---

## Step 2 — D-pad KeyEvent Override

The app must intercept raw hardware buttons (e.g. Back, Play/Pause, Menu) from the TV remote.

### Rules
1. **The TV Event Handler Hook:** Register remote button events using React Native's `useTVEventHandler` inside parent screens, and always clean up listeners:
   ```tsx
   import { useEffect } from 'react';
   import { useTVEventHandler, HWEvent } from 'react-native';

   export function useRemoteKeys(onBack: () => void, onPlayPause?: () => void) {
       const handler = (evt: HWEvent) => {
           if (evt.eventType === 'back') {
               onBack();
           } else if (evt.eventType === 'playPause' && onPlayPause) {
               onPlayPause();
           }
       };

       useEffect(() => {
           const tvEventHandler = new useTVEventHandler();
           tvEventHandler.enable(null, handler);
           return () => {
               tvEventHandler.disable();
           };
       }, [onBack, onPlayPause]);
   }
   ```
2. **Platform Invariant Handling:** Android TV remotes emit standard `KeyEvent` key codes, whereas Apple TV remotes map buttons to swipe velocities and specific gestures. Ensure touch/gesture wrappers fallback gracefully.

---

## Step 3 — FlatList Focus Delegation

`FlatList` on TV requires careful index management. Fast D-pad scrolling triggers rendering lags that cause focus to drop off-screen.

### Rules
1. **Maintain Visible Focus Index:** Store the active index state and leverage `scrollToIndex` to keep the list viewport synced:
   ```tsx
   import { useRef, useState } from 'react';
   import { FlatList } from 'react-native';

   const listRef = useRef<FlatList<any>>(null);
   const [activeIndex, setActiveIndex] = useState(0);

   const handleFocus = (index: number) => {
       setActiveIndex(index);
       listRef.current?.scrollToIndex({
           index,
           viewPosition: 0.5, // Keep the focused item centered
           animated: true,
       });
   };
   ```
2. **Optimize Layout Estimates:** Always provide `getItemLayout` to eliminate dynamic layout calculations on high-speed navigation:
   ```tsx
   getItemLayout={(data, index) => (
       { length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index }
   )}
   ```
3. **Prevent Focus Loss on Recycler Bind:** Set `removeClippedSubviews={false}` inside large virtualized lists. If clipping is enabled, off-screen nodes are unmounted, causing the D-pad engine to lose focus entirely when scrolling fast.

---

## Step 4 — TV Active Focus Contrast (A11y)

Active items must be visually distinct instantly. TV screens are viewed from 10 feet away.

### Rules
1. **Minimum Visual Contrast:** Focused items must have a minimum contrast ratio of 4.5:1 relative to their unfocused state.
2. **Combined Visual Cues:** Never rely on color change alone to indicate focus. Combine color changes with scale transforms or thick borders:
   ```tsx
   styles = StyleSheet.create({
       button: {
           backgroundColor: '#1E293B',
           borderWidth: 2,
           borderColor: 'transparent',
           transform: [{ scale: 1.0 }],
       },
       buttonFocused: {
           backgroundColor: '#3B82F6',
           borderColor: '#FFFFFF',
           transform: [{ scale: 1.08 }], // Subtle enlargement for feedback
       }
   });
   ```

---

## Hard Rules

1. **Never use standard TouchableWithoutFeedback** without setting `focusable={true}` and managing visual focus states.
2. **Never enable `removeClippedSubviews`** inside TV `FlatLists`. This triggers focus loss bugs.
3. **Always destroy `useTVEventHandler`** instances on component unmount to prevent severe memory leaks.
4. **Never execute heavy calculations** on remote keypress. Offload interactions to micro-tasks using `InteractionManager.runAfterInteractions`.
5. **Always provide a clear back-navigation escape path** on every screen to prevent app review rejections on Google Play/App Store.

---

## Boundaries — Do Not Overstep

- This skill dictates TV focus and navigation behaviors. It does not replace core React Native components, styling frameworks, or third-party TV navigation libraries.
- Compatibility checks must target React Native TV fork version boundaries (`0.74.x-tv` or similar).

---

## Failure Behavior of This Skill

- **Focus disappears on fast scrolling:** Check if `removeClippedSubviews` is set to `true`. Switch to `false` and verify `getItemLayout` is defined.
- **D-pad navigation jumps over elements:** Ensure all interactive elements are wrapped in `TVFocusGuideView` and align coordinate layouts.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on list rendering optimizations, visual focus styling, or hardware button bindings.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for react/state lifecycle controls.
- `skill_android_permissions` (`Mobile/Platform/Android-Permissions-v2.md`) — for TV-specific manifest permission controls.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 2 TV Integration (RN TV Focus).

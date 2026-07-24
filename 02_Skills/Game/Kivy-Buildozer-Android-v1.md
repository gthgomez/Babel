<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Kivy & Buildozer Android Integration (v1.0)

**Category:** Game
**Status:** Active
**Pairs with:** `domain_kivy_python`
**Last Verified:** 2026-06-26
**Activation:** Load for python tasks targeting Android app deployments, Buildozer configuration setups, Kivy canvas rendering optimizations, or Pyjnius Java class bindings.

---

## Purpose

Developing games and mobile apps in Python using Kivy requires cross-compiling Python packages and assets to Android. The compilation process via Buildozer frequently fails due to incorrect NDK/SDK alignments, missing dependencies, or bad permission declarations. Furthermore, Kivy apps crash on startup or freeze if they make blocking thread calls or fail to handle Android lifecycle events.

This skill governs Buildozer deployments, Kivy mobile canvas configurations, and native Android lifecycle bindings.

---

## Step 1 — Buildozer Configuration (`buildozer.spec`)

Buildozer manages the toolchain configuration. Mismatched library flags result in compilation errors or immediate APK runtime crashes.

### Rules
1. **Declare Accurate Requirements:** Explicitly list all Python dependencies and platform wrappers. Do not rely on implicit library loading:
   ```ini
   # buildozer.spec snippet
   requirements = python3,kivy,pyjnius,requests,sqlite3
   ```
2. **Android Package Metadata & SDK Levels:** Target stable SDK configurations matching current Android compliance (verified Target SDK 34):
   ```ini
   android.api = 34
   android.minapi = 21
   android.ndk_api = 21
   # Supported architectures (ARM64-v8a is mandatory for Google Play)
   android.archs = arm64-v8a, armeabi-v7a
   ```
3. **Declare Permissions:** Declare all required permissions explicitly. Buildozer will not scan your Python files to auto-detect them:
   ```ini
   android.permissions = INTERNET, WRITE_EXTERNAL_STORAGE, ACCESS_FINE_LOCATION
   ```

---

## Step 2 — Kivy Canvas Drawing & Coordinate Scaling

Kivy renders UI using OpenGL instructions via Canvas graphics context. Absolute pixel dimensions result in unreadably small layouts on high-density phone screens.

### Rules
1. **Enforce Density-Independent Scaling:** Import Kivy's `dp` metric helper and wrap all drawing layout offsets and sizes:
   ```python
   from kivy.metrics import dp
   from kivy.uix.widget import Widget
   from kivy.graphics import Color, Rectangle

   class GameCharacter(Widget):
       def __init__(self, **kwargs):
           super().__init__(**kwargs)
           with self.canvas:
               Color(1, 0, 0, 1) # Red color
               # Set initial size to 50dp x 50dp
               self.rect = Rectangle(
                   pos=(dp(100), dp(100)),
                   size=(dp(50), dp(50))
               )
   ```
2. **Canvas State Bindings:** Bind properties to update drawing positions automatically when widgets resize or move:
   ```python
   def on_pos(self, instance, value):
       self.rect.pos = value

   def on_size(self, instance, value):
       self.rect.size = value
   ```

---

## Step 3 — Multi-touch Input Mapping

Mobile games require tracking multiple touch inputs simultaneously.

### Rules
1. **Track Touches via Collision Detection:** Standard widgets override `on_touch_down`, `on_touch_move`, and `on_touch_up`. Always filter events using `collide_point` to prevent touch leaks across overlapping layers:
   ```python
   class Joystick(Widget):
       def on_touch_down(self, touch):
           if self.collide_point(*touch.pos):
               # Claim the touch event to prevent it from leaking to other widgets
               touch.grab(self)
               self.update_joystick(touch.pos)
               return True
           return super().on_touch_down(touch)

       def on_touch_move(self, touch):
           if touch.grab_current is self:
               self.update_joystick(touch.pos)
               return True
           return super().on_touch_move(touch)

       def on_touch_up(self, touch):
           if touch.grab_current is self:
               touch.ungrab(self)
               self.reset_joystick()
               return True
           return super().on_touch_up(touch)
   ```

---

## Step 4 — Python-Android Lifecycle Hooks (`Pyjnius`)

Android suspends application execution when backgrounded. Kivy apps must pause active clocks and release handles.

### Rules
1. **Implement Kivy App Pause/Resume:** Override `on_pause` in your core App class to return `True`, signaling Android that the Python thread is ready to suspend:
   ```python
   from kivy.app import App
   from kivy.clock import Clock

   class GameApp(App):
       def build(self):
           return GameLayout()

       def on_pause(self):
           # Save database entries, flush settings, pause audio/timers
           self.root.pause_game()
           return True # Must return True to allow pause

       def on_resume(self):
           # Restore settings and resume loops
           self.root.resume_game()
   ```
2. **Native Platform Calls via Pyjnius:** Call Java APIs directly for features not covered by Python wrappers (e.g. Android Toast notifications):
   ```python
   from jnius import autoclass

   def show_android_toast(message):
       PythonActivity = autoclass('org.kivy.android.PythonActivity')
       Toast = autoclass('android.widget.Toast')
       String = autoclass('java.lang.String')
       
       activity = PythonActivity.mActivity
       context = activity.getApplicationContext()
       
       # Run on UI thread to prevent thread crashes
       activity.runOnUiThread(lambda: 
           Toast.makeText(context, String(message), Toast.LENGTH_SHORT).show()
       )
   ```

---

## Hard Rules

1. **Never execute long-running calculations** (e.g., download requests, local database writes) on Kivy's main thread. Wrap them in Python `threading.Thread` or use `asynckivy`.
2. **Never draw canvas shapes with static pixel sizes.** Always wrap coordinates in `dp` or scale relative to parent container sizes.
3. **Always return `True`** from `on_pause()` in the App class, unless you explicitly want Android to terminate the process immediately.
4. **Never invoke Android UI modifications** from background Python threads. Always route them through `runOnUiThread` via Pyjnius.
5. **Always wrap Pyjnius autoclass calls** in `try/except` blocks to prevent crashes during local testing on desktop platforms.

---

## Boundaries — Do Not Overstep

- This skill details Python Kivy and Buildozer compilation boundaries. It does not replace core Python guidelines, Android NDK compile chains, or native Gradle configurations.
- NDK compilation architecture variables must be targeted specifically (e.g. `crystax` NDK extensions must be avoided in modern 64-bit chains).

---

## Failure Behavior of This Skill

- **Buildozer compilation aborts during package compilation:** Inspect `buildozer.spec`. Verify target SDK matches API level 34. Check for missing pre-requisite libraries in the Ubuntu host runner.
- **Kivy app displays a black screen and closes on startup:** Execute `adb logcat | grep -i python`. Look for missing package imports, syntax errors in Kivy files, or Pyjnius class loading errors.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on `buildozer.spec` config settings, density metrics, or lifecycle hook testing.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for compiler validation.
- `skill_android_permissions` (`Mobile/Platform/Android-Permissions-v2.md`) — for verifying permission strings.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 2 Game Integration (Kivy/Buildozer).

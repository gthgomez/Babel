/**
 * FrameScheduler — unified frame scheduler for all TUI rendering.
 *
 * Replaces the three independent setInterval loops (WaterfallRenderer 200ms,
 * SpinnerRenderer 80ms, ScreenManager 250ms) with a single requestAnimationFrame-
 * style loop that coalesces dirty-region render requests.
 *
 * Architecture:
 *   - Components call scheduleFrame() or markDirty(region) when their state changes
 *   - The scheduler coalesces all requests within a frame budget window
 *   - A single tick fires, calling all registered render callbacks in priority order
 *   - Continuous animations (spinner) register as permanent dirty sources
 *   - Per-component scheduling: components register with own intervals, conditions,
 *     and pause/resume — no more ad-hoc sub-interval throttling in callbacks.
 *
 * Fix 6: Shared animation clock (ported from Claude Code's ClockContext.tsx).
 *   - tickTime: all subscribers see the same timestamp within a tick
 *   - keepAlive: reference-counted auto-start/stop — no manual lifecycle calls
 *   - blur-aware: slows ticks when terminal is not focused
 */

export type DirtyRegion = 'hud' | 'spinner' | 'stats' | 'content' | 'all';

interface RenderCallback {
  region: DirtyRegion;
  priority: number; // lower = runs first
  fn: () => void;
}

/** Options for per-component frame scheduling. */
export interface ComponentScheduleOptions {
  /** Custom frame interval in ms for this component (overrides global scheduler interval). */
  intervalMs?: number;
  /** Priority (lower = runs first). Default 10. */
  priority?: number;
  /** Optional condition: only tick if this returns true (checked each frame). */
  condition?: () => boolean;
  /** Human-readable label for error diagnostics in tick(). */
  label?: string;
}

/** Internal tracking for a per-component scheduled callback. */
interface ComponentScheduleEntry {
  id: string;
  fn: () => void;
  options: ComponentScheduleOptions;
  lastTickTime: number;
  paused: boolean;
}

/** Per-frame metrics recorded after each tick. */
export interface FrameMetrics {
  /** Monotonically increasing frame counter. */
  frameIndex: number;
  /** Timestamp of the tick (same as FrameScheduler.tickTime). */
  tickTime: number;
  /** Wall-clock duration of the render callback loop in ms. */
  renderDurationMs: number;
  /** Number of registered callbacks that fired this frame. */
  callbackCount: number;
  /** Number of distinct regions that were dirty this frame. */
  regionsRendered: number;
}

export class FrameScheduler {
  private static instance: FrameScheduler | null = null;

  private callbacks: RenderCallback[] = [];
  private dirtyRegions = new Set<DirtyRegion>();
  private permanentDirty = new Set<DirtyRegion>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastFrameTime = 0;
  private _tickTime = 0;

  /** Minimum interval between frames in ms (≈30 FPS for HUD, adapts for streaming) */
  private minFrameInterval = 33;

  /** Whether a frame is currently scheduled to fire */
  private frameRequested = false;

  /** Fix 6: Reference-counted keep-alive — auto-stops when count reaches 0. */
  private _keepAliveCount = 0;

  /** Fix 6: Whether the terminal window currently has focus. */
  private _windowFocused = true;

  // ── Per-component scheduling ────────────────────────────────────────────

  /** Per-component scheduled callbacks, keyed by component ID. */
  private componentEntries = new Map<string, ComponentScheduleEntry>();

  /** Set of component IDs that are dirty (need to tick next frame). */
  private dirtyComponents = new Set<string>();

  /** Set of component IDs that should tick every frame (permanent dirty). */
  private permanentDirtyComponents = new Set<string>();

  // ── Metrics ────────────────────────────────────────────────────────────

  /** Monotonically increasing frame counter. */
  private _frameIndex = 0;

  /** Circular buffer of per-frame metrics (most recent last). */
  private _frameMetrics: FrameMetrics[] = [];

  /** Maximum number of frames retained in the metrics buffer (~4s at 30fps). */
  private static readonly MAX_METRICS = 120;

  /** Total number of callbacks fired across all ticks since start or last metric reset. */
  private _totalCallbacksFired = 0;

  public static getInstance(): FrameScheduler {
    if (!FrameScheduler.instance) {
      FrameScheduler.instance = new FrameScheduler();
    }
    return FrameScheduler.instance;
  }

  /**
   * Register a render callback for a specific region.
   * Called once during component setup (not on every render request).
   *
   * @deprecated Will be removed in a future release. No production callers remain.
   * Use {@link scheduleComponent} for per-component scheduling with
   * independent intervals, pause/resume, and condition checks. `register()` uses
   * a shared region namespace and depends on the global `setFrameInterval()`.
   */
  register(region: DirtyRegion, fn: () => void, priority = 10): () => void {
    const entry: RenderCallback = { region, priority, fn };
    this.callbacks.push(entry);
    this.callbacks.sort((a, b) => a.priority - b.priority);
    return () => {
      const idx = this.callbacks.indexOf(entry);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  /**
   * Mark a region as needing re-render on the next frame.
   * Safe to call from any context (event handlers, timers, streams).
   * Multiple calls for the same region within a frame window are coalesced.
   */
  markDirty(region: DirtyRegion): void {
    this.dirtyRegions.add(region);
    this.requestFrame();
  }

  /**
   * Mark a region as permanently dirty — it will render on every frame
   * as long as it's registered (e.g., spinner animation).
   */
  setPermanentDirty(region: DirtyRegion, active: boolean): void {
    if (active) {
      this.permanentDirty.add(region);
      this.markDirty(region);
    } else {
      this.permanentDirty.delete(region);
    }
  }

  // ── Per-component scheduling ────────────────────────────────────────────

  /**
   * Register a component for per-component frame scheduling.
   *
   * Unlike `register()`, this gives the component its own:
   *   - Frame interval (overrides the global scheduler interval)
   *   - Conditional execution (skip tick if condition() returns false)
   *   - Independent pause/resume
   *   - Dirty tracking (mark only this component, not a whole region)
   *
   * Returns an unregister function. Throws if `id` is already registered.
   *
   * @param id - Unique component identifier (e.g., 'cursor-blink', 'stream-spinner')
   * @param fn - The tick callback
   * @param options - Optional interval, priority, condition, label
   */
  scheduleComponent(
    id: string,
    fn: () => void,
    options: ComponentScheduleOptions = {},
  ): () => void {
    if (this.componentEntries.has(id)) {
      throw new Error(`FrameScheduler: component "${id}" is already scheduled`);
    }

    const entry: ComponentScheduleEntry = {
      id,
      fn,
      options,
      lastTickTime: 0,
      paused: false,
    };
    this.componentEntries.set(id, entry);

    // Auto-start on first component registration if not running
    if (!this.running) this.start();

    // Always tick on first registration
    this.markComponentDirty(id);

    return () => {
      this.componentEntries.delete(id);
      this.dirtyComponents.delete(id);
      this.permanentDirtyComponents.delete(id);
      // If no more component entries, no permanent-dirty regions, and no keep-alive references, auto-stop
      if (
        this._keepAliveCount === 0 &&
        this.componentEntries.size === 0 &&
        this.permanentDirty.size === 0
      ) {
        this.stop();
      }
    };
  }

  /**
   * Mark a single component as dirty (needs to tick next frame).
   * Safe to call from any context.
   */
  markComponentDirty(id: string): void {
    if (!this.componentEntries.has(id)) return;
    this.dirtyComponents.add(id);
    this.requestFrame();
  }

  /**
   * Mark a component as permanently dirty — it ticks every frame.
   */
  setComponentPermanentDirty(id: string, active: boolean): void {
    if (!this.componentEntries.has(id)) return;
    if (active) {
      this.permanentDirtyComponents.add(id);
      this.markComponentDirty(id);
    } else {
      this.permanentDirtyComponents.delete(id);
    }
  }

  /**
   * Pause a component's ticks. Its callback is skipped until resumed.
   */
  pauseComponent(id: string): void {
    const entry = this.componentEntries.get(id);
    if (entry) entry.paused = true;
  }

  /**
   * Resume a paused component's ticks.
   */
  resumeComponent(id: string): void {
    const entry = this.componentEntries.get(id);
    if (entry) {
      entry.paused = false;
      this.markComponentDirty(id);
    }
  }

  /**
   * Check whether a component is currently paused.
   */
  isComponentPaused(id: string): boolean {
    return this.componentEntries.get(id)?.paused ?? false;
  }

  /** Number of registered per-component schedules. */
  get componentCount(): number {
    return this.componentEntries.size;
  }

  /**
   * Request a frame. If a frame is already scheduled within this window,
   * the request is coalesced (no new timer created).
   */
  private requestFrame(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;

    const elapsed = Date.now() - this.lastFrameTime;
    const delay = Math.max(0, this.effectiveFrameInterval - elapsed);

    this.tickTimer = setTimeout(() => this.tick(), delay);
  }

  /**
   * Start the scheduler. Idempotent.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = Date.now();
  }

  /**
   * Stop the scheduler. Cancels any pending frame.
   */
  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.frameRequested = false;
    this.dirtyRegions.clear();
    this.dirtyComponents.clear();
    this.permanentDirtyComponents.clear();
    this.permanentDirty.clear();
    this.componentEntries.clear();
  }

  /**
   * Adapt the minimum frame interval at runtime.
   * Use lower values (16ms) during streaming, higher (100ms) when idle.
   *
   * @deprecated Will be removed in a future release. No production callers remain.
   * This sets the **global** tick rate which affects all region
   * callbacks. Per-component scheduling via {@link scheduleComponent} with
   * `intervalMs` is preferred — each component gets its own independent
   * interval and no longer races on this global setting.
   */
  setFrameInterval(ms: number): void {
    this.minFrameInterval = Math.max(16, Math.min(500, ms));
  }

  /** Whether the scheduler is actively running. */
  isRunning(): boolean {
    return this.running;
  }

  // ── Fix 6: Shared clock API ─────────────────────────────────────

  /**
   * The timestamp of the most recent frame tick. All subscribers within a
   * single tick see the same value — animations stay synchronized.
   */
  get tickTime(): number {
    return this._tickTime;
  }

  /**
   * Acquire a keep-alive reference. The scheduler auto-starts on the first
   * acquisition and auto-stops when the count drops to zero. Use this instead
   * of manual start()/stop() for components that need the scheduler running
   * while they're visible.
   * Returns a release function (call it instead of stop()).
   */
  keepAlive(): () => void {
    this._keepAliveCount++;
    if (!this.running) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._keepAliveCount = Math.max(0, this._keepAliveCount - 1);
      if (
        this._keepAliveCount === 0 &&
        this.componentEntries.size === 0 &&
        this.permanentDirty.size === 0 &&
        this.permanentDirtyComponents.size === 0
      )
        this.stop();
    };
  }

  /**
   * Notify the scheduler that the terminal window focus changed.
   * When blurred, the frame interval doubles to reduce CPU usage.
   */
  setWindowFocused(focused: boolean): void {
    this._windowFocused = focused;
    // Reschedule any pending frame tick with the new effective interval.
    if (this.frameRequested && this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
      this.frameRequested = false;
      this.requestFrame();
    }
  }

  /**
   * Effective frame interval, accounting for focus. When blurred, animations
   * slow down to conserve resources (same pattern as ClockContext.tsx).
   *
   * Exposed for testing. Marked as internal — not part of the stable API.
   * @internal
   */
  getEffectiveFrameInterval(): number {
    return this._windowFocused ? this.minFrameInterval : this.minFrameInterval * 2;
  }

  /**
   * Whether the scheduler currently believes the window has focus.
   * Exposed for testing.
   * @internal
   */
  isWindowFocused(): boolean {
    return this._windowFocused;
  }

  private get effectiveFrameInterval(): number {
    return this.getEffectiveFrameInterval();
  }

  // ── Metrics accessors ──────────────────────────────────────────────────

  /** Return the per-frame metrics history (circular buffer, most recent last). */
  getFrameHistory(): readonly FrameMetrics[] {
    return this._frameMetrics;
  }

  /** Return the most recent frame metrics, or null if no frames have fired. */
  getLatestMetrics(): FrameMetrics | null {
    return this._frameMetrics[this._frameMetrics.length - 1] ?? null;
  }

  /** Return the average render duration in ms across all recorded frames. */
  getAverageRenderDuration(): number {
    if (this._frameMetrics.length === 0) return 0;
    const sum = this._frameMetrics.reduce((s, m) => s + m.renderDurationMs, 0);
    return Math.round((sum / this._frameMetrics.length) * 100) / 100;
  }

  /** Current frame index (monotonically increasing since start or last metrics reset). */
  get frameIndex(): number {
    return this._frameIndex;
  }

  /** Reset metrics counters (frame index, history, callback counts). */
  resetMetrics(): void {
    this._frameIndex = 0;
    this._frameMetrics = [];
    this._totalCallbacksFired = 0;
  }

  /**
   * Reset all internal state for testing purposes.
   * Call this in beforeEach to ensure each test starts with a clean singleton
   * without resorting to (instance as any) property access.
   */
  resetForTest(): void {
    this.stop();
    this.callbacks = [];
    this.permanentDirty = new Set();
    this.componentEntries.clear();
    this.dirtyComponents.clear();
    this.permanentDirtyComponents.clear();
    this._keepAliveCount = 0;
    this._windowFocused = true;
    this.minFrameInterval = 33;
    this.lastFrameTime = 0;
    this._tickTime = 0;
    this.resetMetrics();
  }

  // ── private ──────────────────────────────────────────────────────

  private tick(): void {
    this.frameRequested = false;
    this.tickTimer = null;

    if (!this.running) return;

    this.lastFrameTime = Date.now();
    this._tickTime = this.lastFrameTime; // Fix 6: shared clock for all subscribers
    const now = this._tickTime;

    // Determine which regions actually need rendering this frame
    const activeRegions = new Set<DirtyRegion>();
    for (const r of this.dirtyRegions) activeRegions.add(r);
    for (const r of this.permanentDirty) activeRegions.add(r);
    this.dirtyRegions.clear();

    // ── Per-component callbacks ──────────────────────────────────────────
    // Collect components that should tick this frame (dirty + permanent dirty).
    // Use addedIds to prevent double-tick when a component is in both sets.
    const componentsToTick: ComponentScheduleEntry[] = [];
    const addedIds = new Set<string>();
    for (const id of this.dirtyComponents) {
      const entry = this.componentEntries.get(id);
      if (entry && !entry.paused) {
        componentsToTick.push(entry);
        addedIds.add(id);
      }
    }
    for (const id of this.permanentDirtyComponents) {
      if (addedIds.has(id)) continue; // already added from dirtyComponents
      const entry = this.componentEntries.get(id);
      if (entry && !entry.paused) {
        // Interval throttling: only tick if enough time has passed
        const interval = entry.options.intervalMs ?? this.minFrameInterval;
        if (now - entry.lastTickTime >= interval) {
          componentsToTick.push(entry);
        }
      }
    }
    for (const entry of componentsToTick) {
      this.dirtyComponents.delete(entry.id);
    }

    // Sort component callbacks by priority
    componentsToTick.sort((a, b) => (a.options.priority ?? 10) - (b.options.priority ?? 10));

    const hasRegionWork = activeRegions.size > 0;
    const hasComponentWork = componentsToTick.length > 0;

    if (!hasRegionWork && !hasComponentWork) {
      // If permanent-dirty regions or components exist, keep the loop going
      if (this.permanentDirty.size > 0 || this.permanentDirtyComponents.size > 0) {
        this.requestFrame();
      }
      return;
    }

    // Fire region callbacks in priority order
    const frameStart = performance.now();
    let callbackCount = 0;
    for (const cb of this.callbacks) {
      if (activeRegions.has(cb.region) || activeRegions.has('all')) {
        try {
          cb.fn();
          callbackCount++;
        } catch (err) {
          const label = (cb as { label?: string }).label ?? 'unknown';
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[babel:tui] frame render error in "${label}": ${message}\n`);
        }
      }
    }

    // Fire per-component callbacks
    for (const entry of componentsToTick) {
      // Check condition (if provided)
      try {
        if (entry.options.condition && !entry.options.condition()) continue;
      } catch (err) {
        const label = entry.options.label ?? entry.id;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[babel:tui] component condition error in "${label}": ${message}\n`);
        continue; // skip this component on condition error
      }

      try {
        entry.fn();
        entry.lastTickTime = now;
        callbackCount++;
      } catch (err) {
        const label = entry.options.label ?? entry.id;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[babel:tui] component tick error in "${label}": ${message}\n`);
      }
    }

    const renderDurationMs = performance.now() - frameStart;

    // Record metrics
    this._totalCallbacksFired += callbackCount;
    this._frameMetrics.push({
      frameIndex: this._frameIndex++,
      tickTime: this._tickTime,
      renderDurationMs: Math.round(renderDurationMs * 100) / 100,
      callbackCount,
      regionsRendered: activeRegions.size + (hasComponentWork ? 1 : 0),
    });
    if (this._frameMetrics.length > FrameScheduler.MAX_METRICS) {
      this._frameMetrics.shift();
    }

    // If permanent-dirty regions or components exist, schedule next frame
    if (this.permanentDirty.size > 0 || this.permanentDirtyComponents.size > 0) {
      this.requestFrame();
    }
  }
}

/**
 * Convenience: get the singleton and mark a region dirty in one call.
 */
export function scheduleFrame(region: DirtyRegion = 'all'): void {
  FrameScheduler.getInstance().markDirty(region);
}

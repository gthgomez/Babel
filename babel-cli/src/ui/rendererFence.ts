/**
 * Shared renderer-side half of the exclusive terminal contract.
 *
 * This module deliberately has no dependency on the renderer implementation
 * so both hosted-shell and legacy exclusive-surface paths can use the same
 * fence without creating a waterfall/input-coordinator cycle.
 */

export interface RendererFenceTarget {
  suspendForExclusiveSurface(): () => void;
}

let activeRenderer: RendererFenceTarget | null = null;
let presentationSuspendedDepth = 0;

export function registerRendererFenceTarget(target: RendererFenceTarget): () => void {
  activeRenderer = target;
  return () => {
    if (activeRenderer === target) activeRenderer = null;
  };
}

export function isRendererPresentationSuspended(): boolean {
  return presentationSuspendedDepth > 0;
}

export function suspendActiveRendererForExclusiveSurface(): () => void {
  const releaseRenderer = activeRenderer?.suspendForExclusiveSurface() ?? (() => {});
  presentationSuspendedDepth += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    presentationSuspendedDepth = Math.max(0, presentationSuspendedDepth - 1);
    releaseRenderer();
  };
}

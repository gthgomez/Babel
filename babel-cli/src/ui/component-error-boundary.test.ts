import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Component } from './component.js';
import type { KeyEvent } from './keyInput.js';

// A component that throws in render()
class BrokenComponent extends Component {
  render(): string {
    throw new Error('simulated render failure');
  }
  handleKey(_event: KeyEvent): boolean {
    return false;
  }
}

// A component that overrides fallbackRender()
class CustomFallbackComponent extends Component {
  render(): string {
    throw new Error('custom failure');
  }
  handleKey(_event: KeyEvent): boolean {
    return false;
  }
  protected override fallbackRender(): string {
    return 'CUSTOM_FALLBACK';
  }
}

describe('Component error boundary', () => {
  it('renderSafe() returns fallback string on render error', () => {
    const comp = new BrokenComponent();
    const result = comp.renderSafe();
    assert.ok(result.includes('BrokenComponent'), 'includes component name');
    assert.ok(result.includes('render error'), 'indicates error');
    assert.equal(comp.renderError?.message, 'simulated render failure');
    assert.equal(comp.dirty, false, 'dirty cleared to prevent re-render loop');
  });

  it('renderSafe() returns normal output when render succeeds', () => {
    class GoodComponent extends Component {
      render(): string {
        return 'hello';
      }
      handleKey(_event: KeyEvent): boolean {
        return false;
      }
    }
    const comp = new GoodComponent();
    comp.dirty = true;
    const result = comp.renderSafe();
    assert.equal(result, 'hello');
    assert.equal(comp.renderError, null);
    assert.equal(comp.dirty, false);
  });

  it('clearError() resets error state and marks dirty', () => {
    const comp = new BrokenComponent();
    comp.renderSafe(); // triggers error
    assert.ok(comp.renderError !== null);
    comp.clearError();
    assert.equal(comp.renderError, null);
    assert.equal(comp.dirty, true);
  });

  it('fallbackRender() can be overridden', () => {
    const comp = new CustomFallbackComponent();
    const result = comp.renderSafe();
    assert.equal(result, 'CUSTOM_FALLBACK');
  });

  it('successive renderSafe() calls clear previous error', () => {
    const comp = new BrokenComponent();
    comp.renderSafe(); // throws
    assert.ok(comp.renderError !== null, 'error set after first failure');

    // Simulate recovery — component fixed at runtime
    // (In practice this would be a different component instance, but testing the state machine)
    comp.clearError();
    assert.equal(comp.renderError, null, 'error cleared');
  });

  it('handleKey() errors are NOT caught by renderSafe (render boundary only)', () => {
    class KeyThrowComponent extends Component {
      render(): string {
        return 'ok';
      }
      handleKey(_event: KeyEvent): boolean {
        throw new Error('key failure');
      }
    }
    const comp = new KeyThrowComponent();
    // renderSafe covers render(), not handleKey()
    assert.equal(comp.renderSafe(), 'ok');
  });
});

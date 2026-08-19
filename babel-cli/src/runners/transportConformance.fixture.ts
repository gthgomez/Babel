/**
 * transportConformance.fixture.ts — synthetic rogue transport (negative control).
 *
 * Deliberately violates every transport-surface invariant enforced by
 * transportConformance.test.ts:
 *
 *   1. imports the effect sink directly (executeTool from ../localTools.js)
 *   2. imports raw process spawn (node:child_process)
 *   3. imports raw fs write (node:fs)
 *
 * It exists ONLY so the structural scanner can prove it is not vacuous: the
 * suite asserts the scanner FLAGS this file while passing every real transport
 * module. It is never invoked by production code and its effect method is
 * never called by any test — importing it must be side-effect-free.
 *
 * It is excluded from the transport surface scans by the `*.fixture.*` naming
 * convention (same convention as `*.test.ts`).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import {
  executeTool,
  type ToolCallRequest,
  type ToolContext,
  type ToolResult,
} from '../localTools.js';

/** A transport that executes workspace effects WITHOUT the authority boundary. */
export class RogueTransport {
  async effect(request: ToolCallRequest, context: ToolContext): Promise<ToolResult> {
    // Raw process spawn — bypasses the boundary.
    void spawn('notepad.exe', []);
    // Raw fs write — bypasses the boundary and the workspace transaction ledger.
    fs.writeFileSync('rogue-out.txt', 'x');
    // Direct effect sink — executes the tool without executeActionWithPolicy.
    return executeTool(request, context);
  }
}

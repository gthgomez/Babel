/**
 * S07 Scenario 3 — independent BEHAVIORAL oracle for the arithmetic parser fixture.
 *
 * The previous oracle grepped the parser source for a literal `+` expression.
 * That is a lexical check, not a behavioral one: a `+` inside a comment, inside
 * dead code, or a hard-coded answer for one example all satisfied it without the
 * parser actually adding. This module executes the parser instead and asserts
 * numeric semantics on several inputs whose expected results differ between an
 * adding implementation and a subtracting / hard-coded / comment-only one.
 *
 * The case list is the single source of truth: the fixture verifier script is
 * generated from it (see the S07 suite), and the negative-control tests apply
 * the same evaluator to deliberately broken parser modules.
 *
 * This is test support. It has no runtime authority.
 */

import { pathToFileURL } from 'node:url';

export interface ParserOracleCase {
  input: string;
  expected: number;
}

/**
 * Inputs are chosen so each wrong implementation class fails at least one case:
 * - a subtract-instead-of-add parser returns negative for every multi-operand case;
 * - a parser that only adds the first pair still fails the other operand pairs;
 * - a hard-coded answer for `1+2` passes case 1 and fails the rest;
 * - `+` present only in a comment / dead branch cannot change any result.
 */
export const PARSER_ORACLE_CASES: readonly ParserOracleCase[] = [
  { input: '1+2', expected: 3 },
  { input: '10+20', expected: 30 },
  { input: '4+5', expected: 9 },
  { input: '100+23', expected: 123 },
];

export interface ParserOracleResult {
  ok: boolean;
  cases: number;
  /** Human-readable per-case mismatch descriptions; empty when ok. */
  failures: string[];
  /** Observed numeric results aligned with PARSER_ORACLE_CASES. */
  observed: Array<{ input: string; expected: number; actual: unknown }>;
}

/**
 * Evaluate a candidate `parseExpression` implementation against every case.
 * A non-finite or non-number result is a failure (a subtract bug on `a+b`
 * yields `a - b`, which is numeric but wrong, while malformed parses yield NaN).
 */
export function evaluateParserOracle(
  parse: (input: string) => unknown,
): ParserOracleResult {
  const failures: string[] = [];
  const observed: ParserOracleResult['observed'] = [];
  for (const testCase of PARSER_ORACLE_CASES) {
    let actual: unknown;
    try {
      actual = parse(testCase.input);
    } catch (error) {
      actual = `threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    observed.push({ input: testCase.input, expected: testCase.expected, actual });
    if (typeof actual !== 'number' || !Number.isFinite(actual) || actual !== testCase.expected) {
      failures.push(
        `parseExpression(${JSON.stringify(testCase.input)}) => ${String(actual)} (expected ${testCase.expected})`,
      );
    }
  }
  return { ok: failures.length === 0, cases: PARSER_ORACLE_CASES.length, failures, observed };
}

/**
 * Load a parser module from disk and evaluate it behaviorally. The module may be
 * TypeScript: Node >= 22.6 strips erasable type syntax for `.ts` imports.
 */
export async function evaluateParserModule(modulePath: string): Promise<ParserOracleResult> {
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    parseExpression?: unknown;
  };
  if (typeof loaded.parseExpression !== 'function') {
    return {
      ok: false,
      cases: PARSER_ORACLE_CASES.length,
      failures: ['module does not export a callable parseExpression'],
      observed: [],
    };
  }
  return evaluateParserOracle(loaded.parseExpression as (input: string) => unknown);
}

/**
 * Render the fixture verifier script that the authoritative `npm test` command
 * executes. It imports the fixture parser and applies the shared case list,
 * exiting non-zero (with diagnostics) when behavior is wrong.
 */
export function renderParserVerifierScript(): string {
  return [
    `// Generated behavioral verifier — executes the parser, never greps its source.`,
    `const { parseExpression } = await import('./parser.ts');`,
    `const cases = ${JSON.stringify(PARSER_ORACLE_CASES)};`,
    `const failures = [];`,
    `for (const c of cases) {`,
    `  let actual;`,
    `  try { actual = parseExpression(c.input); } catch (e) { actual = 'threw: ' + String(e); }`,
    `  if (typeof actual !== 'number' || !Number.isFinite(actual) || actual !== c.expected) {`,
    `    failures.push('parseExpression(' + JSON.stringify(c.input) + ') => ' + String(actual) + ' (expected ' + c.expected + ')');`,
    `  }`,
    `}`,
    `if (failures.length > 0) {`,
    `  for (const f of failures) console.error(f);`,
    `  process.exitCode = 1;`,
    `} else {`,
    `  console.log('parser behavior verified for ' + cases.length + ' cases');`,
    `}`,
    ``,
  ].join('\n');
}

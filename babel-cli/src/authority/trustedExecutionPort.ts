import type { TrustedExecutionReadPortV1 } from "../evidence/trustedExecutionIdentity.js";

// This module is outside the public package exports. The symbols are private
// to the trusted authority lane, so application code cannot mint an accepted
// read port by copying its shape or importing the evidence module.
const READ_PORT_BRAND = Symbol("babel.trusted-execution.read-port");
const AUTHORITATIVE_READ_PORT_BRAND = Symbol(
  "babel.trusted-execution.authoritative-read-port",
);

export function createTrustedExecutionReadPortInternal(
  implementation: TrustedExecutionReadPortV1,
  authoritative: boolean,
): TrustedExecutionReadPortV1 {
  const port = {
    [READ_PORT_BRAND]: true,
    ...(authoritative ? { [AUTHORITATIVE_READ_PORT_BRAND]: true } : {}),
    authorize: implementation.authorize,
    get: implementation.get,
    assignmentsForRun: implementation.assignmentsForRun,
  };
  return Object.freeze(port) as TrustedExecutionReadPortV1;
}

export function isTrustedExecutionReadPort(
  value: unknown,
): value is TrustedExecutionReadPortV1 {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[READ_PORT_BRAND] === true &&
    (value as Record<PropertyKey, unknown>)[AUTHORITATIVE_READ_PORT_BRAND] ===
      true,
  );
}

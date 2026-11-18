/**
 * Projection of W01's terminal no-change path into W02's final-revision
 * contract.
 *
 * W02's kernel treats `NO_CHANGE_REQUIRED` as proof-bearing unless
 * `finalRevisionRequired === false`. An ambient read-only chat request has no
 * project-scoped final revision to witness, so it opts out explicitly. A
 * project-scoped accepted no-change must keep the default (witness required).
 *
 * The field is intentionally optional today: the current kernel ignores it and
 * the rebase onto W02 consumes it. The companion test pins both branches so a
 * silent downgrade to UNVERIFIED_PATCH cannot land.
 */
export interface NoChangeFinalRevisionScope {
  finalRevisionRequired?: false
}

export function noChangeFinalRevisionScope(input: {
  ambientReadOnly: boolean
}): NoChangeFinalRevisionScope {
  return input.ambientReadOnly ? { finalRevisionRequired: false } : {}
}

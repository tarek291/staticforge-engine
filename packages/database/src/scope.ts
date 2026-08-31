/**
 * How a tenant read is scoped, in one place.
 *
 * `Project.userId` records who *created* a project. Membership records who may
 * reach it, and the two diverge the moment a second principal — a colleague, or
 * an API key — is given access. Scoping reads by the creator meant a verified
 * EDITOR could pass every gate and then be told the page does not exist, which
 * is the shape of a permission bug that looks like data loss.
 *
 * Expressed once and reused, so a read added later cannot quietly pick the
 * older rule. The creator column is left in place: it still records provenance,
 * and it is no longer an access decision.
 */
export function projectVisibleTo(userId: string): {
  organization: { members: { some: { userId: string } } };
} {
  return { organization: { members: { some: { userId } } } };
}


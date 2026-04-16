/**
 * ACL enforcement for Kiln team configurations.
 *
 * Security invariants:
 * - A caller scoped to teamId T can only read/write config for teamId T.
 * - Platform team callers (isPlatformTeam = true) have org-wide read visibility.
 * - No caller can read another team's watchedRepos or migration-note history
 *   without platform-team scope.
 *
 * This module enforces those invariants as pure functions — the DynamoDB
 * layer additionally enforces them via IAM condition keys (see infra/).
 */

export interface CallerContext {
  /** The teamId extracted from the verified Okta OIDC token */
  callerTeamId: string;
  /** Whether the caller belongs to the platform team (org-wide visibility) */
  isPlatformTeam: boolean;
  /** The orgId the caller belongs to */
  orgId: string;
}

export type AclVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Verify that a caller context is allowed to READ a team's config.
 */
export function canReadConfig(caller: CallerContext, targetTeamId: string): AclVerdict {
  if (caller.callerTeamId === targetTeamId) {
    return { allowed: true };
  }
  if (caller.isPlatformTeam) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Team "${caller.callerTeamId}" is not authorized to read config for team "${targetTeamId}". ` +
      `Only the owning team or the platform team may access this resource.`,
  };
}

/**
 * Verify that a caller context is allowed to WRITE (create/update) a team's config.
 * Write access is strictly limited to the owning team — platform team has read-only
 * org-wide scope, not write.
 */
export function canWriteConfig(caller: CallerContext, targetTeamId: string): AclVerdict {
  if (caller.callerTeamId === targetTeamId) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Team "${caller.callerTeamId}" is not authorized to modify config for team "${targetTeamId}". ` +
      `Config writes are restricted to the owning team.`,
  };
}

/**
 * Verify that a caller may list migration-note history for a given team.
 * Same rules as config read.
 */
export function canReadHistory(caller: CallerContext, targetTeamId: string): AclVerdict {
  return canReadConfig(caller, targetTeamId);
}

/**
 * Assert that two teams belong to the same org.
 * Used to prevent cross-org config reads even for platform teams.
 */
export function assertSameOrg(
  callerOrgId: string,
  targetOrgId: string
): AclVerdict {
  if (callerOrgId === targetOrgId) return { allowed: true };
  return {
    allowed: false,
    reason: `Cross-org access denied: caller org "${callerOrgId}" ≠ target org "${targetOrgId}".`,
  };
}

/**
 * Build a DynamoDB condition expression fragment that scopes reads to teamId.
 * Returns the expression + attribute name map to inject into a QueryCommand.
 */
export function buildTeamScopeCondition(teamId: string): {
  keyConditionExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, string>;
} {
  return {
    keyConditionExpression: "#tid = :tid",
    expressionAttributeNames: { "#tid": "teamId" },
    expressionAttributeValues: { ":tid": teamId },
  };
}

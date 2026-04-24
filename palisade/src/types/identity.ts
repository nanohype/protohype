/**
 * Composite identity used for rate-limiting + audit trail. Any field may be
 * absent; the rate-limiter escalates on whichever field is present, with
 * `workspaceId` taking precedence when set.
 */
export interface Identity {
  readonly ip: string;
  readonly apiKeyHash?: string;
  readonly workspaceId?: string;
}

export function identityKey(id: Identity): string {
  if (id.workspaceId) return `ws:${id.workspaceId}`;
  if (id.apiKeyHash) return `key:${id.apiKeyHash}`;
  return `ip:${id.ip}`;
}

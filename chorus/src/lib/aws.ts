/**
 * Shared defaults for AWS SDK clients. The region fallback matches the
 * one CDK injects into running containers; local/test processes that
 * don't set AWS_REGION end up in us-east-1 rather than throwing so the
 * SDK initializes deterministically.
 */
export function awsRegion(): string {
  return process.env['AWS_REGION'] ?? 'us-east-1';
}

export const AWS_MAX_ATTEMPTS = 3;

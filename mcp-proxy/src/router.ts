/**
 * Route resolution — parses the incoming path prefix and returns an initialised McpServer.
 * Credentials are loaded from Secrets Manager (cached per warm Lambda).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  hubspotCredentials,
  gdriveCredentials,
  gcalCredentials,
  analyticsCredentials,
  gcseCredentials,
  stripeCredentials,
} from './auth.js';
import {
  createHubSpotServer,
  createGDriveServer,
  createGCalServer,
  createAnalyticsServer,
  createGCSEServer,
  createStripeServer,
} from './servers/index.js';
import { logger } from './logger.js';

/** Supported service keys derived from the first path segment. */
export type ServiceKey = 'hubspot' | 'gdrive' | 'gcal' | 'analytics' | 'gcse' | 'stripe';

/** Parse the first segment of a path (e.g., "/hubspot/..." → "hubspot"). */
export function parseServiceKey(rawPath: string): ServiceKey {
  const segment = rawPath.split('/').filter(Boolean)[0]?.toLowerCase();
  const valid: ServiceKey[] = ['hubspot', 'gdrive', 'gcal', 'analytics', 'gcse', 'stripe'];
  if (!segment || !valid.includes(segment as ServiceKey)) {
    throw new Error(`Unknown service path '${rawPath}'. Valid paths: ${valid.map(v => `/${v}`).join(', ')}`);
  }
  return segment as ServiceKey;
}

/** Create the appropriate MCP server for the given service key. */
export async function resolveServer(serviceKey: ServiceKey): Promise<McpServer> {
  logger.info('router: resolving server', { service: serviceKey });

  switch (serviceKey) {
    case 'hubspot': {
      const creds = await hubspotCredentials();
      return createHubSpotServer(creds);
    }
    case 'gdrive': {
      const creds = await gdriveCredentials();
      return createGDriveServer(creds);
    }
    case 'gcal': {
      const creds = await gcalCredentials();
      return createGCalServer(creds);
    }
    case 'analytics': {
      const creds = await analyticsCredentials();
      return createAnalyticsServer(creds);
    }
    case 'gcse': {
      const creds = await gcseCredentials();
      return createGCSEServer(creds);
    }
    case 'stripe': {
      const creds = await stripeCredentials();
      return createStripeServer(creds);
    }
  }
}

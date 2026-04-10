/**
 * Google Analytics 4 MCP server.
 * Uses a service account with GA4 Data API access.
 * Tools: run report, realtime report, list properties.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { google, analyticsdata_v1beta } from 'googleapis';
import { z } from 'zod';
import { AnalyticsCredentials } from '../auth.js';

function buildAnalyticsClient(
  creds: AnalyticsCredentials
): analyticsdata_v1beta.Analyticsdata {
  const auth = new google.auth.JWT({
    email: (creds.serviceAccountKey as { client_email: string }).client_email,
    key: (creds.serviceAccountKey as { private_key: string }).private_key,
    scopes: [
      'https://www.googleapis.com/auth/analytics.readonly',
    ],
  });
  return google.analyticsdata({ version: 'v1beta', auth });
}

export function createAnalyticsServer(creds: AnalyticsCredentials): McpServer {
  const analytics = buildAnalyticsClient(creds);
  const server = new McpServer({ name: 'mcp-analytics', version: '0.1.0' });

  server.tool(
    'ga_run_report',
    'Run a Google Analytics 4 report. Returns metrics and dimensions for the specified date range.',
    {
      propertyId: z
        .string()
        .optional()
        .describe('GA4 property ID (e.g., "123456789"). Defaults to the configured property.'),
      dateRanges: z
        .array(
          z.object({
            startDate: z.string().describe('Start date (e.g., "2025-01-01" or "7daysAgo")'),
            endDate: z.string().describe('End date (e.g., "2025-01-31" or "today")'),
          })
        )
        .min(1)
        .max(4)
        .describe('One or more date ranges'),
      dimensions: z
        .array(z.string())
        .optional()
        .describe('Dimension names (e.g., ["date", "country", "sessionSource"])'),
      metrics: z
        .array(z.string())
        .describe('Metric names (e.g., ["sessions", "activeUsers", "bounceRate"])'),
      dimensionFilter: z
        .string()
        .optional()
        .describe('Optional JSON-encoded DimensionFilterClause'),
      orderBys: z
        .array(
          z.object({
            metric: z.object({ metricName: z.string() }).optional(),
            dimension: z.object({ dimensionName: z.string() }).optional(),
            desc: z.boolean().default(false),
          })
        )
        .optional()
        .describe('Sort order'),
      limit: z.number().int().min(1).max(10000).default(100).describe('Row limit'),
    },
    async ({ propertyId, dateRanges, dimensions, metrics, limit, orderBys }) => {
      const pid = propertyId ?? creds.propertyId;
      const res = await analytics.properties.runReport({
        property: `properties/${pid}`,
        requestBody: {
          dateRanges,
          dimensions: dimensions?.map(name => ({ name })),
          metrics: metrics.map(name => ({ name })),
          limit,
          orderBys: orderBys?.map(o => ({
            metric: o.metric,
            dimension: o.dimension,
            desc: o.desc,
          })),
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'ga_realtime_report',
    'Get realtime Google Analytics 4 data (active users, top pages, traffic sources).',
    {
      propertyId: z.string().optional().describe('GA4 property ID. Defaults to the configured property.'),
      dimensions: z
        .array(z.string())
        .default(['unifiedScreenName'])
        .describe('Realtime dimensions (e.g., ["country", "unifiedScreenName"])'),
      metrics: z
        .array(z.string())
        .default(['activeUsers'])
        .describe('Realtime metrics (e.g., ["activeUsers"])'),
      limit: z.number().int().min(1).max(100).default(10).describe('Row limit'),
    },
    async ({ propertyId, dimensions, metrics, limit }) => {
      const pid = propertyId ?? creds.propertyId;
      const res = await analytics.properties.runRealtimeReport({
        property: `properties/${pid}`,
        requestBody: {
          dimensions: dimensions.map(name => ({ name })),
          metrics: metrics.map(name => ({ name })),
          limit,
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'ga_list_properties',
    'List Google Analytics 4 properties accessible to the service account.',
    {
      accountId: z.string().optional().describe('GA account ID to filter by'),
    },
    async ({ accountId }) => {
      // Use the Admin API to list properties
      const adminAuth = new google.auth.JWT({
        email: (creds.serviceAccountKey as { client_email: string }).client_email,
        key: (creds.serviceAccountKey as { private_key: string }).private_key,
        scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      });
      const admin = google.analyticsadmin({ version: 'v1beta', auth: adminAuth });
      const filter = accountId ? `parent:accounts/${accountId}` : undefined;
      const res = await admin.properties.list({
        filter,
        pageSize: 50,
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  return server;
}

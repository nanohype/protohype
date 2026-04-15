/**
 * Google Custom Search Engine (GCSE) MCP server.
 * Uses a Google API key and a Custom Search Engine ID.
 * Tools: web search, image search.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { google } from 'googleapis';
import { z } from 'zod';

export function createGCSEServer(creds: { apiKey: string; engineId: string }): McpServer {
  const customsearch = google.customsearch('v1');
  const server = new McpServer({ name: 'mcp-gcse', version: '0.1.0' });

  server.registerTool(
    'gcse_search',
    {
      description: 'Perform a web search using Google Custom Search Engine.',
      inputSchema: {
        query: z.string().min(1).describe('Search query'),
        num: z.number().int().min(1).max(10).default(10).describe('Number of results (max 10 per Google API limits)'),
        start: z.number().int().min(1).max(91).default(1).describe('Result offset for pagination (1-based, max 91)'),
        siteSearch: z.string().optional().describe('Restrict search to this domain (e.g., "docs.anthropic.com")'),
        dateRestrict: z.string().optional().describe('Restrict by date (e.g., "d7" for last 7 days, "m3" for last 3 months)'),
        lr: z.string().optional().describe('Language restrict (e.g., "lang_en")'),
      },
    },
    async ({ query, num, start, siteSearch, dateRestrict, lr }) => {
      const res = await customsearch.cse.list({
        auth: creds.apiKey,
        cx: creds.engineId,
        q: query,
        num,
        start,
        siteSearch,
        dateRestrict,
        lr,
      });

      const items = (res.data.items ?? []).map(item => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet,
        displayLink: item.displayLink,
        formattedUrl: item.formattedUrl,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalResults: res.data.searchInformation?.totalResults,
                searchTime: res.data.searchInformation?.formattedSearchTime,
                items,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    'gcse_search_images',
    {
      description: 'Search for images using Google Custom Search Engine.',
      inputSchema: {
        query: z.string().min(1).describe('Image search query'),
        num: z.number().int().min(1).max(10).default(10).describe('Number of results'),
        start: z.number().int().min(1).max(91).default(1).describe('Result offset for pagination'),
        imgSize: z
          .enum(['huge', 'icon', 'large', 'medium', 'small', 'xlarge', 'xxlarge'])
          .optional()
          .describe('Filter by image size'),
        imgType: z
          .enum(['clipart', 'face', 'lineart', 'stock', 'photo', 'animated'])
          .optional()
          .describe('Filter by image type'),
        fileType: z.string().optional().describe('Filter by file extension (e.g., "jpg", "png")'),
      },
    },
    async ({ query, num, start, imgSize, imgType, fileType }) => {
      const res = await customsearch.cse.list({
        auth: creds.apiKey,
        cx: creds.engineId,
        q: query,
        searchType: 'image',
        num,
        start,
        imgSize,
        imgType,
        fileType,
      });

      const items = (res.data.items ?? []).map(item => ({
        title: item.title,
        link: item.link,
        image: item.image,
        snippet: item.snippet,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalResults: res.data.searchInformation?.totalResults,
                items,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

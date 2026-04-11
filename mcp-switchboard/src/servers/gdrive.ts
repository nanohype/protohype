/**
 * Google Drive MCP server.
 * Uses a service account (with optional domain-wide delegation).
 * Tools: list, search, get metadata, read content, create.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { google, drive_v3 } from 'googleapis';
import { z } from 'zod';
import { GoogleSACredentials } from '../auth.js';

function buildDriveClient(creds: GoogleSACredentials): drive_v3.Drive {
  const auth = new google.auth.JWT({
    email: (creds.serviceAccountKey as { client_email: string }).client_email,
    key: (creds.serviceAccountKey as { private_key: string }).private_key,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    subject: creds.impersonateEmail,
  });
  return google.drive({ version: 'v3', auth });
}

export function createGDriveServer(creds: GoogleSACredentials): McpServer {
  const drive = buildDriveClient(creds);
  const server = new McpServer({ name: 'mcp-gdrive', version: '0.1.0' });

  server.tool(
    'gdrive_list_files',
    'List files in Google Drive. Optionally filter by folder or MIME type.',
    {
      folderId: z.string().optional().describe('Parent folder ID. Omit for root.'),
      mimeType: z.string().optional().describe('Filter by MIME type (e.g., application/vnd.google-apps.document)'),
      pageSize: z.number().int().min(1).max(100).default(20).describe('Max results'),
      pageToken: z.string().optional().describe('Pagination token from previous response'),
    },
    async ({ folderId, mimeType, pageSize, pageToken }) => {
      const q: string[] = ["trashed = false"];
      if (folderId) q.push(`'${folderId}' in parents`);
      if (mimeType) q.push(`mimeType = '${mimeType}'`);

      const res = await drive.files.list({
        q: q.join(' and '),
        pageSize,
        pageToken,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)',
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'gdrive_search_files',
    'Full-text search across Google Drive files.',
    {
      query: z.string().describe('Search query (e.g., "quarterly report" or "name contains \'budget\'")'),
      pageSize: z.number().int().min(1).max(100).default(10).describe('Max results'),
      pageToken: z.string().optional().describe('Pagination token'),
    },
    async ({ query, pageSize, pageToken }) => {
      const res = await drive.files.list({
        q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
        pageSize,
        pageToken,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)',
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'gdrive_get_file',
    'Get metadata for a specific Google Drive file.',
    {
      fileId: z.string().describe('Google Drive file ID'),
    },
    async ({ fileId }) => {
      const res = await drive.files.get({
        fileId,
        fields: 'id, name, mimeType, size, modifiedTime, createdTime, webViewLink, parents, owners, description',
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'gdrive_read_file',
    'Read the text content of a Google Drive file. Supports Google Docs (exported as plain text) and plain text files.',
    {
      fileId: z.string().describe('Google Drive file ID'),
    },
    async ({ fileId }) => {
      // First get metadata to determine type
      const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
      const mimeType = meta.data.mimeType ?? '';

      let text: string;

      if (mimeType === 'application/vnd.google-apps.document') {
        // Export Google Doc as plain text
        const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
        text = res.data as string;
      } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        // Export Sheets as CSV
        const res = await drive.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'text' });
        text = res.data as string;
      } else {
        // Download binary/text file content
        const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
        text = res.data as string;
      }

      return {
        content: [
          { type: 'text', text: `File: ${meta.data.name}\n\n${text}` },
        ],
      };
    }
  );

  server.tool(
    'gdrive_create_file',
    'Create a new text file in Google Drive.',
    {
      name: z.string().describe('File name'),
      content: z.string().describe('Text content of the file'),
      folderId: z.string().optional().describe('Parent folder ID. Omit for root.'),
      mimeType: z.string().default('text/plain').describe('MIME type of the file content'),
    },
    async ({ name, content, folderId, mimeType }) => {
      const media = { mimeType, body: content };
      const requestBody: drive_v3.Schema$File = { name };
      if (folderId) requestBody.parents = [folderId];

      const res = await drive.files.create({
        requestBody,
        media,
        fields: 'id, name, webViewLink',
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  return server;
}

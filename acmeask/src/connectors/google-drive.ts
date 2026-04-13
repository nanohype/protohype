/**
 * Google Drive connector — uses Drive API v3 with user's OAuth token.
 * Retrieves files visible to the user (ACL enforced by Google).
 */
import { google } from 'googleapis';
import { GaxiosError } from 'gaxios';
import type { ConnectorAdapter, RetrievalChunk } from '../types';
import { config } from '../config';
import { logger } from '../middleware/logger';
import { chunkText } from './chunker';
import { refreshGoogleToken } from '../auth/oauth-flow';
import { getUserTokens, storeUserTokens } from '../auth/token-store';

// MIME types we can export as plain text
const EXPORTABLE_MIME_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

export const googleDriveConnector: ConnectorAdapter = {
  name: 'google-drive',

  async retrieve(
    userAccessToken: string,
    query: string,
    topK: number,
    timeoutMs: number
  ): Promise<RetrievalChunk[]> {
    const auth = new google.auth.OAuth2(
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
      config.GOOGLE_REDIRECT_URI
    );
    auth.setCredentials({ access_token: userAccessToken });

    const drive = google.drive({ version: 'v3', auth });

    let files;
    try {
      const response = await drive.files.list({
        q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
        fields: 'files(id,name,webViewLink,modifiedTime,lastModifyingUser(displayName),mimeType)',
        pageSize: topK,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        // timeout via underlying gaxios — set via retryConfig
      });
      files = response.data.files ?? [];
    } catch (err) {
      const gaxiosErr = err as GaxiosError;
      if (gaxiosErr.response?.status === 401) {
        throw Object.assign(new Error('Google Drive auth error'), { type: 'auth-error' });
      }
      throw err;
    }

    const chunks: RetrievalChunk[] = [];

    for (const file of files) {
      if (!file.id || !file.name) continue;

      let content = file.name; // fallback if export fails
      const exportMime = EXPORTABLE_MIME_TYPES[file.mimeType ?? ''];

      if (exportMime) {
        try {
          const exportResponse = await drive.files.export({
            fileId: file.id,
            mimeType: exportMime,
          });
          content = exportResponse.data as string;
        } catch {
          // Can't export — use title only
          content = file.name;
        }
      }

      const textChunks = chunkText(content, 512, 64);
      const lastModifiedAt = file.modifiedTime ? new Date(file.modifiedTime) : null;
      const author = file.lastModifyingUser?.displayName ?? null;

      textChunks.forEach((chunk, i) => {
        chunks.push({
          connectorName: 'google-drive',
          docId: `gdrive:${file.id}:${i}`,
          docTitle: file.name!,
          docUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}`,
          lastModifiedAt,
          author,
          chunkText: chunk,
          rawScore: 1 - i * 0.1,
        });
      });

      if (chunks.length >= topK) break;
    }

    logger.debug({ connector: 'google-drive', chunksReturned: chunks.length }, 'Google Drive retrieval complete');
    return chunks.slice(0, topK);
  },
};

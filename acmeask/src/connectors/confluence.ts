/**
 * Confluence Cloud connector — uses CQL search API with user's OAuth token.
 * ACLs enforced by Atlassian (user token only accesses authorized spaces/pages).
 */
import axios, { AxiosError } from 'axios';
import type { ConnectorAdapter, RetrievalChunk } from '../types';
import { config } from '../config';
import { logger } from '../middleware/logger';
import { chunkText } from './chunker';

interface ConfluencePage {
  id: string;
  title: string;
  _links: { webui: string };
  body?: { view?: { value?: string } };
  history?: {
    lastUpdated?: {
      when?: string;
      by?: { displayName?: string };
    };
  };
}

interface ConfluenceSearchResponse {
  results: ConfluencePage[];
  totalSize: number;
}

export const confluenceConnector: ConnectorAdapter = {
  name: 'confluence',

  async retrieve(
    userAccessToken: string,
    query: string,
    topK: number,
    timeoutMs: number
  ): Promise<RetrievalChunk[]> {
    const baseUrl = config.CONFLUENCE_BASE_URL;
    const headers = {
      Authorization: `Bearer ${userAccessToken}`,
      Accept: 'application/json',
    };

    // CQL full-text search
    const cql = `text ~ "${query.replace(/"/g, '\\"')}" AND type = "page"`;

    let searchData: ConfluenceSearchResponse;
    try {
      const response = await axios.get<ConfluenceSearchResponse>(
        `${baseUrl}/rest/api/content/search`,
        {
          headers,
          timeout: timeoutMs,
          params: {
            cql,
            limit: topK,
            expand: 'body.view,history.lastUpdated',
          },
        }
      );
      searchData = response.data;
    } catch (err) {
      const axiosErr = err as AxiosError;
      if (axiosErr.response?.status === 401) {
        throw Object.assign(new Error('Confluence auth error'), { type: 'auth-error' });
      }
      throw err;
    }

    const chunks: RetrievalChunk[] = [];

    for (const page of searchData.results) {
      const rawHtml = page.body?.view?.value ?? page.title;
      const plainText = stripHtml(rawHtml);
      const textChunks = chunkText(plainText, 512, 64);

      const lastUpdatedWhen = page.history?.lastUpdated?.when ?? null;
      const author = page.history?.lastUpdated?.by?.displayName ?? null;
      const webUrl = `${baseUrl}${page._links.webui}`;

      textChunks.forEach((chunk, i) => {
        chunks.push({
          connectorName: 'confluence',
          docId: `confluence:${page.id}:${i}`,
          docTitle: page.title,
          docUrl: webUrl,
          lastModifiedAt: lastUpdatedWhen ? new Date(lastUpdatedWhen) : null,
          author,
          chunkText: chunk,
          rawScore: 1 - i * 0.1,
        });
      });

      if (chunks.length >= topK) break;
    }

    logger.debug({ connector: 'confluence', chunksReturned: chunks.length }, 'Confluence retrieval complete');
    return chunks.slice(0, topK);
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

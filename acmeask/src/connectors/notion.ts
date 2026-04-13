/**
 * Notion connector — retrieves chunks using user's OAuth token.
 * ACLs enforced by Notion API (user token only sees authorized pages).
 */
import { Client as NotionClient, APIResponseError } from '@notionhq/client';
import type { ConnectorAdapter, RetrievalChunk } from '../types';
import { logger } from '../middleware/logger';
import { chunkText } from './chunker';

export const notionConnector: ConnectorAdapter = {
  name: 'notion',

  async retrieve(
    userAccessToken: string,
    query: string,
    topK: number,
    timeoutMs: number
  ): Promise<RetrievalChunk[]> {
    const notion = new NotionClient({
      auth: userAccessToken,
      timeoutMs,
    });

    let searchResults;
    try {
      searchResults = await notion.search({
        query,
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: topK,
      });
    } catch (err) {
      if (err instanceof APIResponseError && err.status === 401) {
        throw Object.assign(new Error('Notion auth error'), { type: 'auth-error' });
      }
      throw err;
    }

    const chunks: RetrievalChunk[] = [];

    for (const result of searchResults.results) {
      if (result.object !== 'page') continue;
      const page = result as Extract<typeof result, { object: 'page' }>;

      // Extract title
      let title = 'Untitled';
      const titleProp = Object.values(page.properties ?? {}).find(
        (p) => p.type === 'title'
      );
      if (titleProp?.type === 'title' && titleProp.title.length > 0) {
        title = titleProp.title.map((t) => t.plain_text).join('');
      }

      // Extract metadata
      const lastEditedTime = 'last_edited_time' in page ? page.last_edited_time : null;
      const lastEditedBy =
        'last_edited_by' in page && page.last_edited_by
          ? ('name' in page.last_edited_by ? page.last_edited_by.name : null)
          : null;

      // Retrieve page content via blocks API
      let pageContent = '';
      try {
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        pageContent = extractTextFromBlocks(blocks.results);
      } catch {
        // Content not accessible or empty — still include page metadata
        pageContent = title;
      }

      const textChunks = chunkText(pageContent, 512, 64);
      const docUrl = 'url' in page ? page.url : `https://notion.so/${page.id.replace(/-/g, '')}`;

      textChunks.forEach((chunk, i) => {
        chunks.push({
          connectorName: 'notion',
          docId: `notion:${page.id}:${i}`,
          docTitle: title,
          docUrl,
          lastModifiedAt: lastEditedTime ? new Date(lastEditedTime) : null,
          author: lastEditedBy ?? null,
          chunkText: chunk,
          rawScore: 1 - i * 0.1, // higher score for earlier chunks
        });
      });

      if (chunks.length >= topK) break;
    }

    logger.debug({ connector: 'notion', chunksReturned: chunks.length }, 'Notion retrieval complete');
    return chunks.slice(0, topK);
  },
};

function extractTextFromBlocks(blocks: unknown[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    const type = b.type as string;
    const content = b[type] as Record<string, unknown> | undefined;
    if (!content) continue;

    const richText = content.rich_text as Array<{ plain_text: string }> | undefined;
    if (richText) {
      lines.push(richText.map((rt) => rt.plain_text).join(''));
    }
  }
  return lines.join('\n');
}

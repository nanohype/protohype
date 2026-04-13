import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  ConnectorAdapter,
  ConnectorName,
  DocumentChunk,
  OAuthToken,
} from './types.js';

const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const CHUNK_SIZE_TOKENS = 512;
const CHUNK_OVERLAP_TOKENS = 64;
// CANDIDATES_PER_SOURCE: 15 per source × 3 sources = 45 total → reranked to 30 → top 5 for generation
const CANDIDATES_PER_SOURCE = 15;

function chunkText(text: string): string[] {
  const charsPerChunk = CHUNK_SIZE_TOKENS * 4;
  const overlapChars = CHUNK_OVERLAP_TOKENS * 4;
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + charsPerChunk, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += charsPerChunk - overlapChars;
  }

  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}

export class MultiSourceRetriever {
  private bedrockClient: BedrockRuntimeClient;
  private adapters: Map<ConnectorName, ConnectorAdapter>;

  constructor(
    bedrockClient: BedrockRuntimeClient,
    adapters: ConnectorAdapter[],
  ) {
    this.bedrockClient = bedrockClient;
    this.adapters = new Map(adapters.map(a => [a.name, a]));
  }

  async retrieve(
    query: string,
    userTokens: Partial<Record<ConnectorName, OAuthToken>>,
  ): Promise<{
    chunks: DocumentChunk[];
    connectorStatuses: Record<ConnectorName, 'ok' | 'unavailable' | 'not_connected'>;
  }> {
    const queryEmbedding = await this.embed(query);

    const connectorStatuses: Record<ConnectorName, 'ok' | 'unavailable' | 'not_connected'> =
      { notion: 'not_connected', confluence: 'not_connected', gdrive: 'not_connected' };

    const connectorResults = await Promise.allSettled(
      (['notion', 'confluence', 'gdrive'] as ConnectorName[]).map(
        async (connectorName) => {
          const token = userTokens[connectorName];
          if (!token) return { name: connectorName, chunks: [] };

          const adapter = this.adapters.get(connectorName);
          if (!adapter) return { name: connectorName, chunks: [] };

          const searchResults = await adapter
            .search(query, token)
            .then(r => r.slice(0, CANDIDATES_PER_SOURCE));

          const allChunks: DocumentChunk[] = [];
          for (const result of searchResults) {
            let content: { content: string; lastModified: Date };
            try {
              content = await adapter.fetchContent(result.docId, token);
            } catch {
              content = { content: result.snippet, lastModified: result.lastModified };
            }

            const rawChunks = chunkText(content.content);
            for (let i = 0; i < rawChunks.length; i++) {
              // PR-01 fix: fail individual chunk embed gracefully
              try {
                const embedding = await this.embed(rawChunks[i] ?? '');
                const score = cosineSimilarity(queryEmbedding, embedding);
                allChunks.push({
                  docId: result.docId,
                  title: result.title,
                  url: result.url,
                  lastModified: content.lastModified,
                  source: connectorName,
                  content: rawChunks[i] ?? '',
                  chunkIndex: i,
                  embedding,
                  score,
                });
              } catch {
                // Transient embed failure — push chunk with score 0, won't reach top-5
                allChunks.push({
                  docId: result.docId,
                  title: result.title,
                  url: result.url,
                  lastModified: content.lastModified,
                  source: connectorName,
                  content: rawChunks[i] ?? '',
                  chunkIndex: i,
                  embedding: [],
                  score: 0,
                });
              }
            }
          }
          return { name: connectorName, chunks: allChunks };
        },
      ),
    );

    const allChunks: DocumentChunk[] = [];
    for (let i = 0; i < connectorResults.length; i++) {
      const connectorName = (['notion', 'confluence', 'gdrive'] as ConnectorName[])[i]!;
      const result = connectorResults[i]!;
      if (result.status === 'fulfilled') {
        const token = userTokens[connectorName];
        connectorStatuses[connectorName] = token ? 'ok' : 'not_connected';
        allChunks.push(...result.value.chunks);
      } else {
        connectorStatuses[connectorName] = userTokens[connectorName]
          ? 'unavailable'
          : 'not_connected';
      }
    }

    allChunks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { chunks: allChunks.slice(0, 30), connectorStatuses };
  }

  private async embed(text: string): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      body: Buffer.from(JSON.stringify({ inputText: text.slice(0, 8000) })),
      contentType: 'application/json',
      accept: 'application/json',
    });
    const response = await this.bedrockClient.send(command);
    const body = JSON.parse(Buffer.from(response.body).toString());
    return body.embedding as number[];
  }
}

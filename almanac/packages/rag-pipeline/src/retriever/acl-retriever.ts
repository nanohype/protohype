/**
 * ACL-aware retriever for Almanac RAG pipeline.
 *
 * Security contract:
 * - ACL filter is applied at the OpenSearch query layer (pre-filter), NOT post-retrieval.
 * - The user's Okta ID must be present in the chunk's aclUserIds field.
 * - If zero results after ACL filter, returns empty array -- never retries without filter.
 * - Defensive post-retrieval check as belt-and-suspenders.
 */

import {
  Client as OpenSearchClient,
  RequestParams,
} from "@opensearch-project/opensearch";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

export interface ChunkMetadata {
  chunkId: string;
  docId: string;
  docTitle: string;
  docUrl: string;
  sourceSystem: "notion" | "confluence" | "gdrive";
  spaceKey?: string;
  workspaceId?: string;
  driveId?: string;
  lastModified: string; // ISO 8601
  aclUserIds: string[]; // Okta user IDs -- never null, empty means no access
  chunkIndex: number;
  tokenCount: number;
  chunkText: string;
  aclHash: string;
}

export interface RetrievalResult {
  chunks: ChunkMetadata[];
  aclRedactedCount: number; // Defensive filter hits (should always be 0)
}

const OPENSEARCH_INDEX = "almanac-chunks";
const TOP_K_INITIAL = 20;
const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";

export class AclRetriever {
  private readonly osClient: OpenSearchClient;
  private readonly bedrockClient: BedrockRuntimeClient;

  constructor(osClient: OpenSearchClient, bedrockClient: BedrockRuntimeClient) {
    this.osClient = osClient;
    this.bedrockClient = bedrockClient;
  }

  async retrieve(query: string, oktaUserId: string): Promise<RetrievalResult> {
    const queryEmbedding = await this.embedQuery(query);

    // ACL-filtered k-NN: filter applied BEFORE k-NN scoring (pre-filter)
    const searchBody = {
      size: TOP_K_INITIAL,
      query: {
        bool: {
          filter: [
            // SECURITY: enforce ACL at database layer
            { term: { aclUserIds: oktaUserId } },
          ],
          must: [
            { knn: { embedding: { vector: queryEmbedding, k: TOP_K_INITIAL } } },
          ],
        },
      },
      _source: { excludes: ["embedding"] },
    };

    const response = await this.osClient.search({
      index: OPENSEARCH_INDEX,
      body: searchBody,
    } as RequestParams.Search);

    const hits = response.body.hits?.hits ?? [];

    // Defensive post-retrieval ACL check (belt-and-suspenders)
    const safeChunks: ChunkMetadata[] = [];
    let defensiveFilterCount = 0;

    for (const hit of hits) {
      const chunk = hit._source as ChunkMetadata;
      if (!chunk.aclUserIds.includes(oktaUserId)) {
        console.error(
          `[SECURITY] ACL bypass detected: chunk ${chunk.chunkId} returned for user ${oktaUserId} not in aclUserIds. Filtering.`
        );
        defensiveFilterCount++;
        continue;
      }
      safeChunks.push(chunk);
    }

    return { chunks: safeChunks, aclRedactedCount: defensiveFilterCount };
  }

  private async embedQuery(query: string): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: query, dimensions: 1536, normalize: true }),
    });
    const response = await this.bedrockClient.send(command);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    return body.embedding as number[];
  }
}

/**
 * MCP tool definitions for the memory server.
 *
 * Tools:
 *  memory_store   – persist a memory entry with content + optional metadata/tags/TTL
 *  memory_query   – semantic search over an agent's memories
 *  memory_list    – paginated list of memories for an agent (newest-first)
 *  memory_delete  – delete a single memory by ID
 */

import { McpTool } from "./protocol";

export const MEMORY_STORE: McpTool = {
  name: "memory_store",
  description:
    "Store a new memory entry for an agent. Returns the unique memoryId. " +
    "An embedding is computed automatically for semantic retrieval. " +
    "Set ttlSeconds to auto-expire the entry.",
  inputSchema: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Unique identifier for the agent owning this memory.",
      },
      content: {
        type: "string",
        description: "The text content to remember.",
      },
      metadata: {
        type: "object",
        description:
          "Arbitrary key-value metadata (must be JSON-serialisable, max 4 KB).",
        properties: {},
      },
      tags: {
        type: "array",
        description: "Optional string tags for filtering.",
        items: { type: "string" },
      },
      ttlSeconds: {
        type: "number",
        description:
          "Optional TTL in seconds from now. If omitted the entry never expires.",
      },
    },
    required: ["agentId", "content"],
  },
};

export const MEMORY_QUERY: McpTool = {
  name: "memory_query",
  description:
    "Semantically search an agent's stored memories. Returns up to topK results " +
    "sorted by cosine similarity to the query text. " +
    "Optionally filter by tags (all provided tags must be present).",
  inputSchema: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Agent whose memories to search.",
      },
      query: {
        type: "string",
        description: "Natural-language query text.",
      },
      topK: {
        type: "number",
        description: "Maximum number of results to return. Default: 5, max: 20.",
      },
      minScore: {
        type: "number",
        description:
          "Minimum cosine similarity threshold (0–1). Default: 0.0 (no threshold).",
      },
      tags: {
        type: "array",
        description: "Filter to memories that have ALL of these tags.",
        items: { type: "string" },
      },
    },
    required: ["agentId", "query"],
  },
};

export const MEMORY_LIST: McpTool = {
  name: "memory_list",
  description:
    "List stored memories for an agent, newest-first. " +
    "Supports cursor-based pagination via the nextCursor field in the response.",
  inputSchema: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Agent whose memories to list.",
      },
      limit: {
        type: "number",
        description: "Page size. Default: 20, max: 100.",
      },
      cursor: {
        type: "string",
        description: "Pagination cursor returned by a previous list call.",
      },
      tags: {
        type: "array",
        description: "Filter to memories that have ALL of these tags.",
        items: { type: "string" },
      },
    },
    required: ["agentId"],
  },
};

export const MEMORY_DELETE: McpTool = {
  name: "memory_delete",
  description: "Permanently delete a single memory entry by its ID.",
  inputSchema: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Agent owning the memory.",
      },
      memoryId: {
        type: "string",
        description: "ID returned when the memory was stored.",
      },
    },
    required: ["agentId", "memoryId"],
  },
};

export const ALL_TOOLS: McpTool[] = [
  MEMORY_STORE,
  MEMORY_QUERY,
  MEMORY_LIST,
  MEMORY_DELETE,
];

/**
 * Document chunker -- 512-token sliding window with 64-token overlap.
 * Respects heading structure before falling back to sliding window.
 *
 * CRITICAL: aclUserIds is NEVER null or undefined.
 * ACL resolution failure -> empty array [] (no access granted, not all access).
 */

import { v4 as uuidv4 } from "uuid";
import type { ChunkMetadata } from "../retriever/acl-retriever";

export interface RawDocument {
  docId: string;
  docTitle: string;
  docUrl: string;
  sourceSystem: "notion" | "confluence" | "gdrive";
  lastModified: string;
  content: string;
  aclUserIds: string[];
  spaceKey?: string;
  workspaceId?: string;
  driveId?: string;
}

const CHUNK_SIZE_CHARS = 512 * 4;  // ~512 tokens at 4 chars/token
const OVERLAP_CHARS = 64 * 4;
const HEADING_PATTERN = /^#{1,3} .+$/m;

export class DocumentChunker {
  chunk(doc: RawDocument): Omit<ChunkMetadata, "embedding">[] {
    // Guarantee: aclUserIds is always an array (never null/undefined)
    const aclUserIds: string[] = Array.isArray(doc.aclUserIds) ? doc.aclUserIds : [];
    const sections = this.splitIntoSections(doc);
    const chunks: Omit<ChunkMetadata, "embedding">[] = [];

    for (const section of sections) {
      for (const text of this.slidingWindow(section)) {
        if (!text.trim()) continue; // Skip blank chunks
        chunks.push({
          chunkId: uuidv4(),
          docId: doc.docId,
          docTitle: doc.docTitle,
          docUrl: doc.docUrl,
          sourceSystem: doc.sourceSystem,
          spaceKey: doc.spaceKey,
          workspaceId: doc.workspaceId,
          driveId: doc.driveId,
          lastModified: doc.lastModified,
          aclUserIds,
          aclHash: this.hashAcl(aclUserIds),
          chunkIndex: chunks.length,
          tokenCount: Math.ceil(text.length / 4),
          chunkText: text.trim(),
        });
      }
    }
    return chunks;
  }

  private splitIntoSections(doc: RawDocument): string[] {
    const text = doc.sourceSystem === "confluence"
      ? doc.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
      : doc.content;
    return this.splitByHeadings(text);
  }

  private splitByHeadings(text: string): string[] {
    const lines = text.split("\n");
    const sections: string[] = [];
    let current = "";
    for (const line of lines) {
      if (HEADING_PATTERN.test(line) && current.length > 0) {
        sections.push(current);
        current = line + "\n";
      } else {
        current += line + "\n";
      }
    }
    if (current.trim()) sections.push(current);
    return sections.length > 0 ? sections : [text];
  }

  private slidingWindow(text: string): string[] {
    if (text.length <= CHUNK_SIZE_CHARS) return [text];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      chunks.push(text.slice(start, Math.min(start + CHUNK_SIZE_CHARS, text.length)));
      start += CHUNK_SIZE_CHARS - OVERLAP_CHARS;
    }
    return chunks;
  }

  private hashAcl(userIds: string[]): string {
    const sorted = [...userIds].sort().join(",");
    let hash = 0;
    for (let i = 0; i < sorted.length; i++) {
      hash = (hash << 5) - hash + sorted.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }
}

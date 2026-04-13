/**
 * Notion connector for Almanac.
 *
 * ACL safety:
 * - On ACL resolution failure: aclUserIds defaults to [] (no access granted, NEVER wildcard)
 * - Chunks with aclUserIds=[] are indexed but invisible to all users at retrieval
 * - Triggered by EventBridge every 15 minutes
 */

import { Client as NotionClient } from "@notionhq/client";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DocumentChunker, RawDocument } from "../../rag-pipeline/src/chunker/document-chunker";
import { IdentityService } from "../../identity-service/src/identity-service";
import { v4 as uuidv4 } from "uuid";

const INDEX = "almanac-chunks";
const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

export class NotionConnector {
  private readonly notion = new NotionClient({ auth: process.env.NOTION_INTEGRATION_TOKEN });
  private readonly chunker = new DocumentChunker();

  constructor(
    private readonly opensearch: OpenSearchClient,
    private readonly bedrock: BedrockRuntimeClient,
    private readonly identity: IdentityService
  ) {}

  async sync(): Promise<{ indexed: number; errors: number }> {
    let indexed = 0, errors = 0;
    let cursor: string | undefined;

    do {
      const result = await this.notion.search({ filter: { object: "page" }, page_size: 100, start_cursor: cursor });
      for (const page of result.results) {
        if (page.object !== "page") continue;
        try {
          const content = await this.extractContent(page.id);
          const aclUserIds = await this.resolveAcl(page.id);
          const raw: RawDocument = {
            docId: page.id,
            docTitle: this.extractTitle(page as any),
            docUrl: (page as any).url ?? `https://notion.so/${page.id}`,
            sourceSystem: "notion",
            lastModified: (page as any).last_edited_time ?? new Date().toISOString(),
            content,
            aclUserIds,
            workspaceId: (page as any).workspace_id,
          };
          for (const chunk of this.chunker.chunk(raw)) {
            const embedding = await this.embed(chunk.chunkText);
            await this.opensearch.index({ index: INDEX, id: chunk.chunkId, body: { ...chunk, embedding }, refresh: "false" });
          }
          indexed++;
        } catch (err) {
          console.error(`[NotionConnector] Error indexing ${page.id}:`, err);
          errors++;
        }
      }
      cursor = result.has_more ? result.next_cursor ?? undefined : undefined;
    } while (cursor);

    console.log(`[NotionConnector] Sync done: ${indexed} indexed, ${errors} errors`);
    return { indexed, errors };
  }

  private async resolveAcl(pageId: string): Promise<string[]> {
    try {
      const users = await this.notion.users.list({});
      const ids: string[] = [];
      for (const u of users.results) {
        if (u.type !== "person" || !u.person?.email) continue;
        const oktaId = await this.identity.slackToOkta(u.person.email).catch(() => null);
        if (oktaId) ids.push(oktaId);
      }
      return ids;
    } catch (err) {
      // Fail-safe: return empty (no access) not wildcard
      console.error(`[NotionConnector] ACL resolution failed for ${pageId} -- defaulting to []`, err);
      return [];
    }
  }

  private async extractContent(pageId: string): Promise<string> {
    const blocks = await this.notion.blocks.children.list({ block_id: pageId });
    return (blocks.results as any[]).map((b) => {
      const t = b.type;
      if (t === "paragraph") return this.richText(b.paragraph.rich_text);
      if (["heading_1", "heading_2", "heading_3"].includes(t)) return `${'#'.repeat(parseInt(t.slice(-1)))} ${this.richText(b[t].rich_text)}`;
      if (t === "bulleted_list_item" || t === "numbered_list_item") return `- ${this.richText(b[t].rich_text)}`;
      if (t === "callout") return `> ${this.richText(b.callout.rich_text)}`;
      return "";
    }).filter(Boolean).join("\n");
  }

  private richText(rt: any[]): string {
    return (rt ?? []).map((r: any) => r.plain_text ?? "").join("");
  }

  private extractTitle(page: any): string {
    const prop = Object.values(page.properties ?? {}).find((p: any) => p.type === "title") as any;
    return prop?.title?.[0]?.plain_text ?? "Untitled";
  }

  private async embed(text: string): Promise<number[]> {
    const r = await this.bedrock.send(new InvokeModelCommand({
      modelId: EMBED_MODEL,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text.slice(0, 8000), dimensions: 1536, normalize: true }),
    }));
    return JSON.parse(new TextDecoder().decode(r.body)).embedding;
  }
}

/**
 * Slack bot handler for Almanac.
 *
 * Handles:
 * - app_mention events in channels
 * - message.im events in DMs
 * - block_actions for thumbs up/down feedback
 *
 * Security:
 * - All Slack requests verified via HMAC-SHA256 signature
 * - Rate limit checked per Okta user (Redis, shared state)
 * - Audit log written for every query
 * - ACL-aware retrieval via RAG pipeline
 * - Output monitor blocks prompt injection artifacts before posting
 */

import Bolt, { App } from "@slack/bolt";
import { checkRateLimit } from "./rate-limiter";
import { writeAuditLog, AuditEvent } from "./audit-logger";
import { IdentityService } from "../../../identity-service/src/identity-service";
import { AclRetriever } from "../../rag-pipeline/src/retriever/acl-retriever";
import { AnswerGenerator } from "../../rag-pipeline/src/generator/answer-generator";
import { RerankService } from "./rerank-service";
import { buildResponseBlocks } from "./block-builder";
import { scrubPii } from "./pii-scrubber";
import { monitorOutput, BLOCKED_RESPONSE } from "./output-monitor";
import { v4 as uuidv4 } from "uuid";

export function createAlmanacBot(deps: {
  retriever: AclRetriever;
  generator: AnswerGenerator;
  reranker: RerankService;
  identity: IdentityService;
}): App {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: process.env.NODE_ENV === "development",
    appToken: process.env.SLACK_APP_TOKEN,
  });

  app.event("app_mention", async ({ event, client, say }) => {
    await handleQuery({ event, client, say, deps });
  });

  app.message(async ({ message, client, say }) => {
    if (message.subtype || !("text" in message)) return;
    await handleQuery({ event: message as any, client, say, deps });
  });

  app.action(/feedback_(positive|negative)/, async ({ ack, action, body }) => {
    await ack();
    const feedbackType = (action as any).action_id === "feedback_positive" ? "positive" : "negative";
    const sessionId = (action as any).value ?? "unknown";
    console.log(`[Feedback] ${feedbackType} for session ${sessionId}`);
    // TODO: update DynamoDB record with feedback field
  });

  return app;
}

async function handleQuery({
  event,
  client,
  say,
  deps,
}: {
  event: { user: string; text: string; channel: string; ts: string };
  client: any;
  say: any;
  deps: {
    retriever: AclRetriever;
    generator: AnswerGenerator;
    reranker: RerankService;
    identity: IdentityService;
  };
}) {
  const { retriever, generator, reranker, identity } = deps;
  const sessionId = uuidv4();
  const startTime = Date.now();

  const rawQuery = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!rawQuery) {
    await say("Hi! Ask me anything about NanoCorp's internal docs.");
    return;
  }

  // 1. Resolve identity: Slack ID -> Okta ID
  const oktaUserId = await identity.slackToOkta(event.user);
  if (!oktaUserId) {
    await say("I couldn't verify your identity. Please make sure your Slack account is linked to Okta.");
    return;
  }

  // 2. Check rate limit (Redis shared state -- NOT in-memory)
  const rl = await checkRateLimit(oktaUserId);
  if (!rl.allowed) {
    const retryInSec = Math.ceil((rl.retryAfterMs ?? 30000) / 1000);
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      text: `You've reached the Almanac rate limit. Please wait ${retryInSec}s before trying again.`,
    });
    return;
  }

  // 3. Check OAuth tokens exist (prompt setup if not)
  const hasTokens = await deps.identity.hasAnyTokens(oktaUserId);
  if (!hasTokens) {
    await say(buildSetupPromptBlocks(event.user));
    return;
  }

  // 4. Post thinking placeholder
  const thinkingMsg = await say("Looking through your docs...");

  // 5. Retrieve chunks (ACL-filtered at OpenSearch layer)
  const { chunks } = await retriever.retrieve(rawQuery, oktaUserId);

  // 6. Re-rank top-20 to top-5
  const rerankedChunks = await reranker.rerank(rawQuery, chunks, 5);

  // 7. Generate streaming answer
  let fullAnswer = "";
  const answerChunks: any[] = [];

  for await (const part of generator.generateStream(rawQuery, rerankedChunks)) {
    if (part.type === "delta") {
      fullAnswer += part.text;
    } else if (part.type === "citation_block") {
      answerChunks.push(part);
    }
  }

  const sources = answerChunks[0]?.sources ?? [];
  const latencyMs = Date.now() - startTime;

  // 7.5. Output safety check (prompt injection monitor)
  const monitorResult = monitorOutput(fullAnswer, sessionId);
  if (!monitorResult.safe) {
    fullAnswer = BLOCKED_RESPONSE;
    console.error(`[Bot] Output blocked for session ${sessionId}: ${monitorResult.triggeredPattern}`);
  }

  // 8. Update Slack message with final answer + sources
  const blocks = buildResponseBlocks(fullAnswer, sources, sessionId);
  await client.chat.update({
    channel: event.channel,
    ts: (thinkingMsg as any).ts,
    blocks,
    text: fullAnswer,
  });

  // 9. Write audit log (PII-scrubbed query)
  const scrubbedQuery = await scrubPii(rawQuery);
  const auditEvent: AuditEvent = {
    eventId: sessionId,
    timestamp: new Date().toISOString(),
    slackUserId: event.user,
    oktaUserId,
    queryText: scrubbedQuery,
    retrievedDocIds: rerankedChunks.map((c) => c.docId),
    answerLatencyMs: latencyMs,
    sessionId,
  };
  writeAuditLog(auditEvent).catch((err) =>
    console.error("[AuditLog] Unexpected error:", err)
  );
}

function buildSetupPromptBlocks(slackUserId: string): object {
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hi <@${slackUserId}>! To use Almanac, I need access to your knowledge sources. Connect them below:`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Connect Notion" },
            url: `${process.env.IDENTITY_SERVICE_URL}/oauth/notion/start?userId=${slackUserId}`,
            action_id: "connect_notion",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Connect Confluence" },
            url: `${process.env.IDENTITY_SERVICE_URL}/oauth/confluence/start?userId=${slackUserId}`,
            action_id: "connect_confluence",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Connect Google Drive" },
            url: `${process.env.IDENTITY_SERVICE_URL}/oauth/gdrive/start?userId=${slackUserId}`,
            action_id: "connect_gdrive",
          },
        ],
      },
    ],
  };
}

/**
 * Slack bot handler for Almanac.
 *
 * Security:
 * - Slack HMAC-SHA256 signature verification (Bolt built-in)
 * - Rate limit per Okta user via Redis (shared state, no in-memory Maps)
 * - Audit log every query with DLQ fallback
 * - ACL-aware retrieval (OpenSearch pre-filter)
 * - Output monitor blocks prompt injection before posting to Slack
 */

import { App } from "@slack/bolt";
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

  app.action(/feedback_(positive|negative)/, async ({ ack, action }) => {
    await ack();
    const feedbackType = (action as any).action_id === "feedback_positive" ? "positive" : "negative";
    const sessionId = (action as any).value ?? "unknown";
    console.log(`[Feedback] ${feedbackType} for session ${sessionId}`);
    // TODO: patch DynamoDB audit record with feedback
  });

  return app;
}

async function handleQuery({
  event, client, say, deps,
}: {
  event: { user: string; text: string; channel: string; ts: string };
  client: any;
  say: any;
  deps: { retriever: AclRetriever; generator: AnswerGenerator; reranker: RerankService; identity: IdentityService };
}) {
  const { retriever, generator, reranker, identity } = deps;
  const sessionId = uuidv4();
  const startTime = Date.now();

  const rawQuery = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!rawQuery) {
    await say("Hi! Ask me anything about NanoCorp's internal docs.");
    return;
  }

  // 1. Slack ID -> Okta ID
  const oktaUserId = await identity.slackToOkta(event.user);
  if (!oktaUserId) {
    await say("I couldn't verify your identity. Please make sure your Slack account is linked to Okta.");
    return;
  }

  // 2. Rate limit (Redis shared state -- NOT in-memory)
  const rl = await checkRateLimit(oktaUserId);
  if (!rl.allowed) {
    const retryInSec = Math.ceil((rl.retryAfterMs ?? 30000) / 1000);
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      text: `You've reached the Almanac rate limit. Please wait ${retryInSec}s.`,
    });
    return;
  }

  // 3. OAuth setup check
  if (!(await identity.hasAnyTokens(oktaUserId))) {
    await say(buildSetupPromptBlocks(event.user));
    return;
  }

  // 4. Thinking placeholder
  const thinkingMsg = await say("Looking through your docs...");

  // 5. ACL-filtered retrieval
  const { chunks } = await retriever.retrieve(rawQuery, oktaUserId);

  // 6. Re-rank
  const reranked = await reranker.rerank(rawQuery, chunks, 5);

  // 7. Generate answer (streaming)
  let fullAnswer = "";
  let sources: any[] = [];
  for await (const part of generator.generateStream(rawQuery, reranked)) {
    if (part.type === "delta") fullAnswer += part.text;
    else if (part.type === "citation_block") sources = part.sources ?? [];
  }

  // 7.5. Prompt injection output monitor
  const monitor = monitorOutput(fullAnswer, sessionId);
  if (!monitor.safe) {
    fullAnswer = BLOCKED_RESPONSE;
    console.error(`[Bot] Output blocked (${monitor.triggeredPattern}) session=${sessionId}`);
  }

  // 8. Post final answer
  await client.chat.update({
    channel: event.channel,
    ts: (thinkingMsg as any).ts,
    blocks: buildResponseBlocks(fullAnswer, sources, sessionId),
    text: fullAnswer,
  });

  // 9. Audit log (PII-scrubbed, fire-and-forget with DLQ fallback)
  const auditEvent: AuditEvent = {
    eventId: sessionId,
    timestamp: new Date().toISOString(),
    slackUserId: event.user,
    oktaUserId,
    queryText: await scrubPii(rawQuery),
    retrievedDocIds: reranked.map((c) => c.docId),
    answerLatencyMs: Date.now() - startTime,
    sessionId,
  };
  writeAuditLog(auditEvent).catch((err) => console.error("[AuditLog] Error:", err));
}

function buildSetupPromptBlocks(slackUserId: string): object {
  return {
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `Hi <@${slackUserId}>! Connect your knowledge sources to use Almanac:` } },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Connect Notion" }, url: `${process.env.IDENTITY_SERVICE_URL}/oauth/notion/start?userId=${slackUserId}`, action_id: "connect_notion" },
          { type: "button", text: { type: "plain_text", text: "Connect Confluence" }, url: `${process.env.IDENTITY_SERVICE_URL}/oauth/confluence/start?userId=${slackUserId}`, action_id: "connect_confluence" },
          { type: "button", text: { type: "plain_text", text: "Connect Google Drive" }, url: `${process.env.IDENTITY_SERVICE_URL}/oauth/gdrive/start?userId=${slackUserId}`, action_id: "connect_gdrive" },
        ],
      },
    ],
  };
}

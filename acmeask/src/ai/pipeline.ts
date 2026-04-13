/**
 * Main RAG pipeline orchestration.
 * Runs connector retrieval in parallel, re-ranks, builds prompt, calls LLM.
 */
import { preprocessQuery } from './preprocessor';
import { rerank } from './reranker';
import { buildPrompt } from './prompt-builder';
import { callLlm } from './llm-client';
import { scrubChunksPii } from './pii-scrubber';
import { notionConnector } from '../connectors/notion';
import { confluenceConnector } from '../connectors/confluence';
import { googleDriveConnector } from '../connectors/google-drive';
import { getUserTokens } from '../auth/token-store';
import { emitAuditEvent } from '../audit/logger';
import { config } from '../config';
import { logger } from '../middleware/logger';
import type {
  AskResult,
  ConnectorError,
  ConnectorName,
  RetrievalChunk,
  UserTokens,
} from '../types';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const STALE_THRESHOLD_MS = config.STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

export async function runAskPipeline(
  slackUserId: string,
  oktaUserId: string,
  rawQuestion: string
): Promise<AskResult> {
  const startTime = Date.now();

  // 1. Preprocess query
  const preprocessed = preprocessQuery(rawQuestion);

  if (preprocessed.injectionRisk === 'high') {
    return {
      answer: "I can't process that request. Please ask a straightforward question about Acme knowledge.",
      sources: [],
      connectorErrors: [],
      latencyMs: Date.now() - startTime,
      modelUsed: 'none',
    };
  }

  // 2. Load user tokens
  const userTokens = await getUserTokens(oktaUserId);

  // 3. Parallel connector retrieval
  const { chunks, connectorErrors } = await retrieveFromConnectors(
    preprocessed.sanitizedQuestion,
    userTokens,
    config.TOP_K_PER_CONNECTOR,
    config.RETRIEVAL_TIMEOUT_MS
  );

  // 4. Handle no results
  if (chunks.length === 0) {
    const result: AskResult = {
      answer: "I couldn't find any relevant documents in the knowledge bases you have access to. Try rephrasing your question, or check that you've connected your Notion, Confluence, and Google Drive accounts.",
      sources: [],
      connectorErrors,
      latencyMs: Date.now() - startTime,
      modelUsed: 'none',
    };
    await emitAudit(slackUserId, oktaUserId, preprocessed.scrubbedForLog, preprocessed.hasPiiDetected, chunks, result, startTime);
    return result;
  }

  // 5. Re-rank
  const rankedChunks = await rerank(preprocessed.sanitizedQuestion, chunks, config.TOP_K_FINAL);

  // 6. Annotate staleness
  const annotated = rankedChunks.map((chunk) => ({
    ...chunk,
    isStale: chunk.lastModifiedAt
      ? Date.now() - chunk.lastModifiedAt.getTime() > STALE_THRESHOLD_MS
      : false,
    freshnessUnknown: chunk.lastModifiedAt === null,
  }));

  // 7. PII scrub chunk text before LLM
  const scrubbedChunks = scrubChunksPii(annotated);

  // 8. Build prompt and call LLM
  const prompt = buildPrompt(preprocessed.sanitizedQuestion, scrubbedChunks);
  const { answer, modelUsed } = await callLlm(prompt);

  const latencyMs = Date.now() - startTime;

  const askResult: AskResult = {
    answer,
    sources: annotated,
    connectorErrors,
    latencyMs,
    modelUsed,
  };

  // 9. Emit audit log (async, non-blocking)
  await emitAudit(
    slackUserId,
    oktaUserId,
    preprocessed.scrubbedForLog,
    preprocessed.hasPiiDetected,
    annotated,
    askResult,
    startTime,
    prompt
  );

  logger.info(
    { slackUserId, latencyMs, sourcesCount: annotated.length, modelUsed },
    'AskPipeline complete'
  );

  return askResult;
}

async function retrieveFromConnectors(
  query: string,
  userTokens: UserTokens | null,
  topK: number,
  timeoutMs: number
): Promise<{ chunks: RetrievalChunk[]; connectorErrors: ConnectorError[] }> {
  const connectorJobs: Array<{
    name: ConnectorName;
    token: string | undefined;
    adapter: typeof notionConnector;
  }> = [
    { name: 'notion', token: userTokens?.notionToken, adapter: notionConnector },
    { name: 'confluence', token: userTokens?.confluenceToken, adapter: confluenceConnector },
    { name: 'google-drive', token: userTokens?.googleDriveToken, adapter: googleDriveConnector },
  ];

  const results = await Promise.allSettled(
    connectorJobs.map(async ({ name, token, adapter }) => {
      if (!token) {
        // User hasn't authorized this connector — skip silently
        return { name, chunks: [] as RetrievalChunk[], skipped: true };
      }
      const chunks = await withTimeout(
        adapter.retrieve(token, query, topK, timeoutMs),
        timeoutMs,
        `${name} connector timeout`
      );
      return { name, chunks, skipped: false };
    })
  );

  const chunks: RetrievalChunk[] = [];
  const connectorErrors: ConnectorError[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (!result.value.skipped) {
        chunks.push(...result.value.chunks);
      }
    } else {
      const err = result.reason as Error & { type?: string };
      const connectorName = connectorJobs[results.indexOf(result)].name;
      connectorErrors.push({
        connectorName,
        reason: err.type === 'auth-error' ? 'auth-error' : 'unavailable',
        message: err.message,
      });
      logger.warn({ connectorName, err: err.message }, 'Connector retrieval failed');
    }
  }

  return { chunks, connectorErrors };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}

async function emitAudit(
  slackUserId: string,
  oktaUserId: string,
  questionScrubbed: string,
  hasPii: boolean,
  chunks: RetrievalChunk[],
  result: AskResult,
  startTime: number,
  prompt?: string
) {
  const staleCount = chunks.filter((c) => 'isStale' in c && (c as { isStale: boolean }).isStale).length;
  await emitAuditEvent({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    slackUserId,
    oktaUserId,
    questionScrubbed,
    hasPii,
    connectorNames: [...new Set(chunks.map((c) => c.connectorName))],
    retrievedDocIds: chunks.map((c) => c.docId),
    llmModel: result.modelUsed,
    llmPromptHash: prompt ? createHash('sha256').update(prompt).digest('hex').slice(0, 16) : 'none',
    responseHash: createHash('sha256').update(result.answer).digest('hex').slice(0, 16),
    latencyMs: Date.now() - startTime,
    staleSourcesCount: staleCount,
    connectorErrors: result.connectorErrors,
  });
}

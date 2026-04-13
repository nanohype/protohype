// Core domain types for AcmeAsk

export type ConnectorName = 'notion' | 'confluence' | 'google-drive';

export interface UserTokens {
  slackUserId: string;
  oktaUserId: string;
  notionToken?: string;
  confluenceToken?: string;
  googleDriveToken?: string;
  googleDriveRefreshToken?: string;
}

export interface RetrievalChunk {
  connectorName: ConnectorName;
  docId: string;
  docTitle: string;
  docUrl: string;
  lastModifiedAt: Date | null;
  author: string | null;
  chunkText: string;
  rawScore: number;
}

export interface RankedChunk extends RetrievalChunk {
  unifiedScore: number;
  isStale: boolean;
  freshnessUnknown: boolean;
}

export interface AskResult {
  answer: string;
  sources: RankedChunk[];
  connectorErrors: ConnectorError[];
  latencyMs: number;
  modelUsed: string;
}

export interface ConnectorError {
  connectorName: ConnectorName;
  reason: 'timeout' | 'auth-error' | 'unavailable';
  message: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  slackUserId: string;
  oktaUserId: string;
  questionScrubbed: string;
  hasPii: boolean;
  connectorNames: ConnectorName[];
  retrievedDocIds: string[];
  llmModel: string;
  llmPromptHash: string;
  responseHash: string;
  latencyMs: number;
  staleSourcesCount: number;
  connectorErrors: ConnectorError[];
}

export interface PreprocessResult {
  sanitizedQuestion: string;
  scrubbedForLog: string;
  hasPiiDetected: boolean;
  injectionRisk: 'none' | 'low' | 'high';
}

export interface ConnectorAdapter {
  name: ConnectorName;
  retrieve(
    userAccessToken: string,
    query: string,
    topK: number,
    timeoutMs: number
  ): Promise<RetrievalChunk[]>;
}

export type ConnectorName = 'notion' | 'confluence' | 'gdrive';

export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  provider: ConnectorName;
  userId: string;
}

export interface SearchResult {
  docId: string;
  title: string;
  url: string;
  snippet: string;
  lastModified: Date;
  source: ConnectorName;
}

export interface DocumentContent {
  docId: string;
  title: string;
  url: string;
  lastModified: Date;
  content: string;
  source: ConnectorName;
}

export interface DocumentChunk {
  docId: string;
  title: string;
  url: string;
  lastModified: Date;
  source: ConnectorName;
  content: string;
  chunkIndex: number;
  embedding?: number[];
  score?: number;
}

export interface Citation {
  docId: string;
  title: string;
  url: string;
  lastModified: Date;
  source: ConnectorName;
}

export interface StaleWarning {
  docTitle: string;
  lastModified: Date;
  daysAgo: number;
}

export interface AlmanacAnswer {
  text: string;
  citations: Citation[];
  staleWarnings: StaleWarning[];
  connectorStatuses: Record<ConnectorName, 'ok' | 'unavailable' | 'not_connected'>;
  latencyMs: number;
}

export interface PiiCheckResult {
  containsPii: boolean;
  piiTypes: string[];
}

export interface ConnectorAdapter {
  readonly name: ConnectorName;
  search(query: string, userToken: OAuthToken): Promise<SearchResult[]>;
  fetchContent(docId: string, userToken: OAuthToken): Promise<DocumentContent>;
}

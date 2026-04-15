export interface RetrievalHit {
  docId: string;
  source: "notion" | "confluence" | "drive";
  title: string;
  url: string;
  chunkText: string;
  lastModified: string;
  score: number;
  accessVerified: boolean;
  wasRedacted: boolean;
}

export interface ConnectorSearchResult {
  hits: RetrievalHit[];
  errors: ConnectorError[];
}

export interface ConnectorError {
  source: "notion" | "confluence" | "drive";
  message: string;
  partial: boolean;
}

export interface SourceCitation {
  source: "notion" | "confluence" | "drive";
  docId: string;
  title: string;
  url: string;
  lastModified: string;
  isStale: boolean;
}

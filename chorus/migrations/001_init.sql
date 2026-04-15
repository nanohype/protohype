-- Chorus Database Migration 001: Initial Schema
BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE TABLE feedback_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id UUID NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('zendesk','gong','delighted','productboard')),
    source_item_id TEXT NOT NULL,
    source_url TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lang TEXT NOT NULL DEFAULT 'en',
    redacted_text TEXT NOT NULL,
    embedding VECTOR(1024),
    proposed_entry_id UUID,
    proposed_at TIMESTAMPTZ,
    proposal_score FLOAT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','deferred','manual_triage')),
    UNIQUE (source, source_item_id)
);
CREATE TABLE raw_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feedback_item_id UUID NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
    verbatim_text TEXT NOT NULL,
    customer_ref TEXT,
    acl_squad_ids TEXT[] NOT NULL DEFAULT '{}',
    acl_csm_ids TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE backlog_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    productboard_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    embedding VECTOR(1024),
    embedded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE feedback_items ADD CONSTRAINT fk_feedback_proposed_entry FOREIGN KEY (proposed_entry_id) REFERENCES backlog_entries(id);
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id UUID NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('INGEST','REDACT','EMBED','MATCH','PROPOSE','APPROVE','REJECT','CREATE','DEFER')),
    actor TEXT NOT NULL DEFAULT 'system',
    feedback_item_id UUID REFERENCES feedback_items(id),
    backlog_entry_id UUID REFERENCES backlog_entries(id),
    detail JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE ingestion_cursors (
    source TEXT PRIMARY KEY CHECK (source IN ('zendesk','gong','delighted')),
    cursor_value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_feedback_items_embedding ON feedback_items USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_backlog_entries_embedding ON backlog_entries USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_feedback_items_status_proposed_at ON feedback_items (status, proposed_at DESC);
CREATE INDEX idx_audit_log_correlation_id_created_at ON audit_log (correlation_id, created_at DESC);
CREATE INDEX idx_raw_evidence_acl_squad_ids ON raw_evidence USING gin (acl_squad_ids);
CREATE INDEX idx_raw_evidence_acl_csm_ids ON raw_evidence USING gin (acl_csm_ids);
COMMIT;

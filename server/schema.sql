PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_json TEXT NOT NULL,
  headers_redacted_json TEXT NOT NULL,
  content_type TEXT,
  body_size INTEGER NOT NULL DEFAULT 0,
  body_sha256 TEXT,
  body_preview TEXT NOT NULL,
  body_text TEXT,
  body_storage_kind TEXT NOT NULL,
  received_at TEXT NOT NULL,
  source_ip TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'blocked', 'oversized', 'released', 'failed', 'skipped', 'archived')),
  latest_error TEXT,
  released_at TEXT,
  archived_at TEXT,
  block_reason TEXT,
  FOREIGN KEY (webhook_id) REFERENCES webhook_endpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_webhook_received ON deliveries(webhook_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_status_received ON deliveries(status, received_at DESC);

CREATE TABLE IF NOT EXISTS release_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('simulated')),
  destination_label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT NOT NULL CHECK (result IN ('success', 'failed', 'skipped')),
  error_summary TEXT,
  FOREIGN KEY (delivery_id) REFERENCES deliveries(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  summary TEXT NOT NULL
);

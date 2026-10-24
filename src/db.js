import { mkdirSync } from 'node:fs';
import { config } from './config.js';

// Thin adapter: same `query(sql, params) -> { rows }` / `exec(sql)` API for
// embedded PGlite (default, zero install) and a real PostgreSQL via `pg`.

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL REFERENCES users(id),
  project TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  context TEXT,
  template_id TEXT NOT NULL,
  template_version INT NOT NULL,
  template_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  timezone TEXT,
  consent_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  audio_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  audio_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','live','processing','completed')),
  report JSONB,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions (owner_id, project, created_at);

-- Versioned, idempotent event log (README §4 "Eventi di sistema").
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  segment_id TEXT,
  speaker TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_state TEXT NOT NULL DEFAULT 'done',
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, seq);

-- Only FINAL transcript segments are stored; partials are replaced in place.
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  speaker TEXT NOT NULL,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  start_ms INT,
  end_ms INT,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'final' CHECK (status IN ('final','corrected')),
  extraction_state TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_state IN ('pending','done','failed')),
  embedding vector(${config.embedDim}),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_segments_session ON segments (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_segments_hnsw ON segments USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS segment_versions (
  id SERIAL PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  version INT NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extracted information. Every row carries provenance (segments + quote).
CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('field','fact','commitment','decision','need','risk','open_question')),
  field_key TEXT,
  content TEXT NOT NULL,
  value TEXT,
  epistemic TEXT NOT NULL CHECK (epistemic IN ('dichiarazione','fatto_verificato','inferenza','ipotesi','raccomandazione')),
  certainty TEXT NOT NULL DEFAULT 'certo',
  status TEXT NOT NULL CHECK (status IN ('non_specificato','ambiguo','da_verificare','confermato','contestato','superato')),
  status_reason TEXT,
  confidence REAL,
  owner TEXT,
  due_text TEXT,
  due_date TEXT,
  conditions TEXT,
  quote TEXT NOT NULL,
  source_segment_ids TEXT[] NOT NULL,
  template_id TEXT,
  template_version INT,
  extractor TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  superseded_by UUID,
  embedding vector(${config.embedDim}),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_items_session ON items (session_id, kind);
CREATE INDEX IF NOT EXISTS idx_items_field ON items (field_key);
CREATE INDEX IF NOT EXISTS idx_items_sources ON items USING gin (source_segment_ids);

CREATE TABLE IF NOT EXISTS item_history (
  id SERIAL PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  change JSONB NOT NULL,
  author TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('question','alert')),
  priority TEXT NOT NULL DEFAULT 'medium',
  text TEXT NOT NULL,
  reason TEXT,
  rule_id TEXT,
  source_segment_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  dedupe_key TEXT NOT NULL,
  dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suggestions_session ON suggestions (session_id, created_at);

-- Invalid model outputs never reach items (TC14 / F19).
CREATE TABLE IF NOT EXISTS quarantine (
  id SERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  raw TEXT,
  error TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metrics (
  id SERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value_ms REAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO users (id, name) VALUES ('luca', 'Luca'), ('giulia', 'Giulia')
  ON CONFLICT (id) DO NOTHING;
`;

export async function createDb({ inMemory = false } = {}) {
  let client;
  if (config.databaseUrl && !inMemory) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    client = {
      kind: 'postgres',
      query: (sql, params) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    let pglite;
    if (inMemory) {
      pglite = new PGlite({ extensions: { vector } });
    } else {
      mkdirSync(config.dataDir, { recursive: true });
      pglite = new PGlite(config.dataDir, { extensions: { vector } });
    }
    client = {
      kind: inMemory ? 'pglite-memory' : 'pglite',
      query: (sql, params) => pglite.query(sql, params),
      exec: (sql) => pglite.exec(sql),
      close: () => pglite.close(),
    };
  }
  await client.exec(SCHEMA);
  return client;
}

export const toVector = (arr) => (arr ? `[${arr.join(',')}]` : null);

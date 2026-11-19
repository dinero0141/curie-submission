-- Curie schema. Idempotent: every statement is IF NOT EXISTS, so re-running is a no-op.
-- Offsets are UTF-16 code units into documents.content, half-open [start, end).
-- Never slice content in SQL (substring counts code points); slice in JS.

CREATE TABLE IF NOT EXISTS documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  format          text NOT NULL CHECK (format IN ('markdown', 'text')),
  content         text NOT NULL,
  utf16_length    int  NOT NULL,                 -- content.length computed in JS
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  failure_code    text,
  failure_message text,
  passage_count   int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  ready_at        timestamptz
);

CREATE TABLE IF NOT EXISTS passages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal        int  NOT NULL,
  start_offset   int  NOT NULL,
  end_offset     int  NOT NULL,
  heading        text,
  sentences      jsonb NOT NULL,                 -- [{start, end}] absolute UTF-16 spans
  text           text NOT NULL,
  token_estimate int  NOT NULL,
  tsv            tsvector GENERATED ALWAYS AS
                   (to_tsvector('english', coalesce(heading, '') || ' ' || text)) STORED,
  CONSTRAINT passages_document_ordinal_key UNIQUE (document_id, ordinal),
  CONSTRAINT passages_offsets_check CHECK (start_offset >= 0 AND end_offset > start_offset)
);

CREATE INDEX IF NOT EXISTS passages_tsv_idx ON passages USING gin (tsv);

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_document_id_idx ON conversations (document_id);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             int  NOT NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL DEFAULT '',
  -- user messages are inserted 'completed'
  status          text NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed')),
  answerable      boolean,
  citations       jsonb,
  retrieval       jsonb,
  finish_reason   text,
  error_code      text,
  error_message   text,
  model           text,
  usage           jsonb,
  attempts        int  NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT messages_conversation_seq_key UNIQUE (conversation_id, seq)
);

-- At most one assistant answer in flight per conversation (mapped to 409 answer_in_progress).
CREATE UNIQUE INDEX IF NOT EXISTS one_inflight_answer ON messages (conversation_id)
  WHERE role = 'assistant' AND status IN ('pending', 'streaming');

-- Reconciler scans for stale in-flight rows.
CREATE INDEX IF NOT EXISTS documents_inflight_idx ON documents (updated_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS messages_inflight_idx ON messages (updated_at)
  WHERE role = 'assistant' AND status IN ('pending', 'streaming');

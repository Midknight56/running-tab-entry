ALTER TABLE calls ADD COLUMN chain_hash TEXT;
ALTER TABLE calls ADD COLUMN first_status TEXT;

CREATE TABLE chain_heads (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  signature TEXT,
  signed_at INTEGER NOT NULL,
  entry_kind TEXT NOT NULL,
  call_seq INTEGER NOT NULL,
  PRIMARY KEY (agent_id, seq)
);
CREATE INDEX chain_heads_call ON chain_heads (agent_id, entry_kind, call_seq);

CREATE TABLE chain_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  call_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reference TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  chain_hash TEXT,
  chain_seq INTEGER
);
CREATE UNIQUE INDEX chain_events_seq ON chain_events (agent_id, chain_seq) WHERE chain_seq IS NOT NULL;
CREATE UNIQUE INDEX chain_events_once ON chain_events (agent_id, call_seq, kind, reference);

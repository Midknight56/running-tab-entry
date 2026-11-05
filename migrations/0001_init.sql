-- Running Tab ledger. Money is integer cents everywhere.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  ip_day_hash TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX workspaces_ip ON workspaces (ip_day_hash);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX agents_ws ON agents (ws_id);

CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'DUE', 'PAID')),
  total_cents INTEGER NOT NULL DEFAULT 0,
  threshold_cents INTEGER NOT NULL,
  order_id TEXT,
  capture_id TEXT,
  captured_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  due_at INTEGER,
  paid_at INTEGER
);
CREATE INDEX tabs_agent ON tabs (agent_id, state);
CREATE INDEX tabs_order ON tabs (order_id);
CREATE INDEX tabs_capture ON tabs (capture_id);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  ws_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_AUDIT', 'BILLABLE', 'STRUCK', 'REFUNDED')),
  reason_code TEXT,
  evidence TEXT,
  judged_by TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX calls_agent_seq ON calls (agent_id, seq);
CREATE INDEX calls_tab ON calls (tab_id, status);
CREATE INDEX calls_ws ON calls (ws_id, created_at);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  verdict TEXT,
  reason_code TEXT,
  evidence TEXT,
  refund_id TEXT,
  refund_status TEXT,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'APPROVED', 'REJECTED', 'WAITING_SELLER', 'REFUNDING', 'REFUNDED')),
  created_at INTEGER NOT NULL
);
CREATE INDEX claims_call ON claims (call_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  verification TEXT NOT NULL,
  resource_id TEXT,
  ws_id TEXT,
  outcome TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE TABLE trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ws_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('paypal', 'model')),
  method_path TEXT,
  http INTEGER,
  paypal_debug_id TEXT,
  request_id TEXT,
  ids_json TEXT,
  model TEXT,
  neurons REAL,
  cached INTEGER,
  verdict TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX trace_ws ON trace (ws_id, at);

CREATE TABLE cache (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  n REAL NOT NULL DEFAULT 0
);

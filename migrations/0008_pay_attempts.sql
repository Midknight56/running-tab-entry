CREATE TABLE pay_attempts (
  tab_id TEXT NOT NULL,
  ws_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('wallet', 'card')),
  request_id TEXT NOT NULL UNIQUE,
  body_json TEXT NOT NULL,
  order_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('SENT', 'DONE', 'FAILED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pay_attempts_tab ON pay_attempts (tab_id, method, state);

ALTER TABLE tabs ADD COLUMN pay_method TEXT;
ALTER TABLE tabs ADD COLUMN pay_started_at INTEGER;

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  ws_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('wallet', 'card')),
  order_id TEXT NOT NULL,
  capture_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  refund_status TEXT
);
CREATE INDEX payments_tab ON payments (tab_id);

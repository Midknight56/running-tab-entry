ALTER TABLE tabs ADD COLUMN wallet_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pay_attempts ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1;
-- The old implementation could have used both the base key and suffix 2.
-- Skip both for existing orders, whose creation bodies were not saved.
UPDATE tabs SET wallet_attempt = 2 WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX wallet_attempt_number ON pay_attempts (tab_id, attempt_no) WHERE method = 'wallet';
CREATE UNIQUE INDEX wallet_unresolved ON pay_attempts (tab_id) WHERE method = 'wallet' AND state = 'SENT';

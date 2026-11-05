-- Existing attempts may already have reached PayPal. Treat them as prior sends.
ALTER TABLE pay_attempts ADD COLUMN send_count INTEGER NOT NULL DEFAULT 1;

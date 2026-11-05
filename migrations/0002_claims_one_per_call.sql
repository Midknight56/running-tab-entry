-- One claim per call, enforced by the database: two claims sent at once cannot both refund.
CREATE UNIQUE INDEX claims_one_per_call ON claims (call_id);

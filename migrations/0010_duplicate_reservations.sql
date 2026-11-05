-- Each duplicate refund keeps a matching charge. This survives concurrent workers and retries.
CREATE TABLE duplicate_reservations (
  claim_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  retained_call_id TEXT NOT NULL,
  CHECK (call_id != retained_call_id)
);
CREATE INDEX duplicate_retained ON duplicate_reservations (retained_call_id);

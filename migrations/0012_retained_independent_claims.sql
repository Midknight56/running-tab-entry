-- Previously blocked independent claims need a seller decision. Send no refund here.
UPDATE claims SET state = 'WAITING_SELLER'
WHERE state = 'APPROVED' AND verdict = 'approve'
  AND reason_code IN ('LATE', 'OFF_REQUEST', 'INCOMPLETE', 'NONSENSE')
  AND refund_id IS NULL AND refund_status IS NULL
  AND EXISTS (SELECT 1 FROM duplicate_reservations WHERE retained_call_id = claims.call_id)
  AND EXISTS (SELECT 1 FROM calls WHERE id = claims.call_id AND status = 'BILLABLE');

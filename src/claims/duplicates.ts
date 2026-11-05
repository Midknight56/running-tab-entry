import type { Call } from '../tab/ledger'

/** Atomically reserve a billed twin. Several duplicates may retain the same original charge. */
export async function reserveDuplicate(db: D1Database, claimId: string, call: Call, citedSeqs?: number[]): Promise<boolean> {
  const cited = citedSeqs ? [...new Set(citedSeqs)] : undefined
  if (cited?.length === 0) return false
  const reserved = await db.prepare(`INSERT OR IGNORE INTO duplicate_reservations (claim_id, call_id, retained_call_id)
    SELECT ?1, claimed.id, twin.id FROM calls claimed JOIN calls twin
      ON twin.tab_id = claimed.tab_id AND twin.agent_id = claimed.agent_id AND twin.ws_id = claimed.ws_id
      AND twin.tool = claimed.tool AND twin.args_json = claimed.args_json AND twin.id != claimed.id
      AND ABS(twin.created_at - claimed.created_at) <= 600000
    WHERE claimed.id = ?2 AND claimed.status = 'BILLABLE' AND claimed.price_cents > 0
      AND twin.status = 'BILLABLE' AND twin.price_cents > 0
      ${cited ? `AND twin.seq IN (${cited.map(() => '?').join(',')})` : ''}
      AND NOT EXISTS (SELECT 1 FROM duplicate_reservations
        WHERE call_id IN (claimed.id, twin.id) OR retained_call_id = claimed.id)
      AND NOT EXISTS (SELECT 1 FROM claims WHERE call_id = twin.id AND state IN ('REFUNDING', 'REFUNDED'))
    ORDER BY twin.seq LIMIT 1`)
    .bind(claimId, call.id, ...(cited ?? [])).run()
  if (reserved.meta.changes) return true
  return !!await db.prepare('SELECT claim_id FROM duplicate_reservations WHERE claim_id = ? AND call_id = ?')
    .bind(claimId, call.id).first()
}

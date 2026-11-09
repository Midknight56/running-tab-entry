// One rule for which tab the desk shows, used by the bill, the demo claim button and the money widget alike:
// the first agent's due tab, else its newest paid tab. The server's demo claim uses the same newest paid tab.
import type { Agent, DeskData, Tab, TabReceipt } from './types'

export const ownTabs = (agent: Agent, tabs: Tab[]) => tabs.filter((t) => t.agent_id === agent.id && t.note !== 'demo history')

export function newestPaid(tabs: Tab[]): Tab | undefined {
  return tabs.filter((t) => t.state === 'PAID')
    .sort((a, b) => (b.paid_at ?? b.created_at) - (a.paid_at ?? a.created_at) || b.created_at - a.created_at)[0]
}

/** The tab the bill shows: due first, else the newest paid one. */
export function billTab(agent: Agent, tabs: Tab[]): Tab | undefined {
  const mine = ownTabs(agent, tabs)
  return mine.find((t) => t.state === 'DUE') ?? newestPaid(mine)
}

/** The receipt of that same newest paid tab, with the agent's name and the PayPal capture id. */
export function deskReceipt(d: DeskData): TabReceipt | null {
  const agent = d.agents[0]
  if (!agent) return null
  const paid = newestPaid(ownTabs(agent, d.tabs))
  if (!paid) return null
  const found = [...(d.receipts ?? []), d.receipt, d.money?.receipt].find((r) => r && r.tab_id === paid.id)
  return found ? { ...found, agent_name: found.agent_name || agent.name, capture_id: found.capture_id ?? paid.capture_id } : null
}

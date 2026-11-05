// Widget 1: one bar per agent against its threshold, coloured by the tab's state.
import type { Agent, Tab } from '../types'
import { usd } from '../types'

export interface TabMeterProps { agents: Agent[]; tabs: Tab[] }

/** The tab each agent is on now: the newest that is not demo history. */
export function currentTabs(agents: Agent[], tabs: Tab[]): { agent: Agent; tab: Tab | null }[] {
  return agents.map((agent) => {
    const mine = tabs.filter((t) => t.agent_id === agent.id && t.note !== 'demo history').sort((a, b) => b.created_at - a.created_at)
    return { agent, tab: mine[0] ?? null }
  })
}

const LABEL: Record<string, string> = { OPEN: 'Open', DUE: 'Due', PAID: 'Paid' }

export function TabMeter({ agents, tabs }: TabMeterProps) {
  const rows = currentTabs(agents, tabs)
  return (
    <div className="rt-meter" role="list" aria-label="Tabs by agent">
      {rows.map(({ agent, tab }) => {
        const total = tab?.total_cents ?? 0
        const threshold = tab?.threshold_cents ?? 500
        const pct = Math.min(100, Math.round((total / threshold) * 100))
        const state = tab?.state ?? 'OPEN'
        return (
          <div className={`rt-meter-row rt-state-${state.toLowerCase()}`} role="listitem" key={agent.id} data-state={state}>
            <div className="rt-meter-head">
              <span className="rt-meter-name">{agent.name}</span>
              <span className="rt-meter-amount">{usd(total)} <span className="rt-dim">of {usd(threshold)}</span></span>
              <span className={`rt-pill rt-pill-${state.toLowerCase()}`}>{LABEL[state]}</span>
            </div>
            {agent.budget_month_cents != null && <p className="rt-dim">Budget {usd(Math.max(0, agent.budget_month_cents - (agent.spent_cents ?? 0)))} left of {usd(agent.budget_month_cents)}</p>}
            <div className="rt-meter-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${agent.name} tab`}>
              <div className="rt-meter-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

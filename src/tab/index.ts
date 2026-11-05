// The add on's public face. Everything here imports only this folder and the kit.
export { withTab, tabDue, payUrl, META_KEY, type TabCtx, type TabRuntime, type TabOptions, type AuditOutcome, type AuditInput } from './with-tab'
export { agentTools, myTab, explainBillTool, reportBadAnswer } from './agent-tools'
export { agentFromRequest, sha256Hex } from './auth'
export { createAgent, currentTab, callsOfTab, getTab, type Agent, type Tab, type Call } from './ledger'
export { codeRules } from './rules'
export { cents, toCents, dollars } from './pricing'

import { useState } from 'react'
import { connectAgent, payWithCard, type ConnectKey, type Session } from './data'
import { usd, type Agent, type Tab } from './types'

export function ConnectCard({ session, agents, tabs }: { session: Session; agents: Agent[]; tabs: Tab[] }) {
  const [monthly, setMonthly] = useState('')
  const [perCall, setPerCall] = useState('')
  const [key, setKey] = useState<ConnectKey | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const due = tabs.filter(t => t.state === 'DUE' && agents.some(a => a.id === t.agent_id && (a.name === 'Your agent' || /^Your agent \d+$/.test(a.name))))
  async function getKey() {
    setBusy(true); setError('')
    try {
      const r = await connectAgent({ ...(monthly !== '' ? { monthly_cents: Math.round(Number(monthly) * 100) } : {}), ...(perCall !== '' ? { max_call_cents: Number(perCall) } : {}) })
      if (r.ok) setKey(r.body)
      else setError(r.body.error ?? 'Could not get a key.')
    } catch { setError('Could not get a key.') }
    setBusy(false)
  }
  async function pay(tabId: string) {
    setBusy(true); setError('')
    try {
      const r = await payWithCard(tabId)
      if (!r.ok) setError(r.body.reason ?? r.body.error ?? 'Payment did not go through. The tab is still open.')
    } catch { setError('Payment did not go through. The tab is still open.') }
    setBusy(false)
  }
  const config = key ? JSON.stringify({ mcpServers: { 'running-tab': { url: key.mcp_url, headers: { Authorization: `Bearer ${key.key}` } } } }) : ''
  return <section className="rt-connect" aria-label="Connect">
    <h2 className="rt-connect-title">Connect an agent</h2>
    <p className="rt-connect-endpoint">MCP endpoint <code>{key?.mcp_url ?? `${location.origin}/mcp`}</code></p>
    <p>Your agent's calls show on this desk. When its tab is due, the call answers TAB_DUE with a pay link.</p>
    <div className="rt-connect-fields">
      <label>Monthly budget ($)<input type="number" min="0" max="1000" step="0.01" value={monthly} onChange={e => setMonthly(e.target.value)} /></label>
      <label>Max per call (cents)<input type="number" min="0" max="10000" step="1" value={perCall} onChange={e => setPerCall(e.target.value)} /></label>
      <button className="rt-btn" disabled={busy} onClick={getKey}>Get a key</button>
    </div>
    {key && <>
      <CopyBlock label="Key" text={key.key} />
      <p className="rt-dim">Expires {new Date(key.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      <CopyBlock label="Client config" text={config} />
      <CopyBlock label="Command" text={`node client/agent.mjs --url ${key.mcp_url} --key ${key.key} --wait`} />
    </>}
    {due.map(t => <div className="rt-connect-pay" key={t.id}>
      <a className="rt-btn rt-primary" href={`/pay/${t.id}`}>Pay {usd(t.total_cents)} with PayPal</a>
      <button className="rt-btn" disabled={busy} onClick={() => pay(t.id)}>Pay with a test card</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
    <details><summary>Demo agents</summary>
      {session.agents.map(a => <p key={a.id}>{a.name} <code>Authorization: Bearer {a.key}</code></p>)}
    </details>
  </section>
}

export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [error, setError] = useState('')
  async function copy() {
    try { await navigator.clipboard.writeText(text); setError('') }
    catch { setError('Could not copy. Select the text to copy it.') }
  }
  return <div className="rt-copy"><span className="rt-copy-label">{label}</span><div className="rt-connect-block"><pre>{text}</pre><button className="rt-btn" aria-label={`Copy ${label}`} onClick={copy}>Copy</button>{error && <span role="status">{error}</span>}</div></div>
}

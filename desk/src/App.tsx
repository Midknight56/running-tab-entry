import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AgStudio, AgStudioProvider } from 'ag-studio-react'
import { AgStudioAiModule, createDataEngine, type AgReportState, type AgStudioApi, type AgStudioApiReadyEvent, type AgStudioStateUpdatedEvent } from 'ag-studio'
import { approveClaim, askDesk, CONNECTION_ERROR, loadDesk, loadTryStatus, payWithCard, runAfterPay, runCalls, startSession, studioSources, verifyLedger, type Session } from './data'
import { setDesk, useDesk } from './store'
import { Panel, TryPanel } from './Panel'
import { deskTheme } from './studio/theme'
import { deskWidgets } from './studio/widgets'
import { useReport } from './studio/use-report'
import { deskAi } from './studio/ai'
import { addWidget, studioApi } from './studio/add-widget'
import { usd } from './types'
import { ConnectCard } from './ConnectCard'
import { TabSummary } from './widgets/TabSummary'
import { TabMeter } from './widgets/TabMeter'
import { MoneyFlow } from './widgets/MoneyFlow'
import { StruckLedger } from './widgets/StruckLedger'
import { ClaimSelection, type ClaimPick } from './claim-selection'

type Busy = '' | 'run' | 'after' | 'card'
const AUDITOR_SCOPE = 'The auditor checks that each answer fits the request. It does not check the math.'
const LOAD_ERROR = 'The desk could not load. Reload the page.'

export function App({ license }: { license: string | null }) {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [sessionRefused, setSessionRefused] = useState(false)
  const [busy, setBusy] = useState<Busy>('')
  const busyRef = useRef(busy)
  busyRef.current = busy
  const [refunding, setRefunding] = useState('')
  const [claimPick, setClaimPick] = useState<ClaimPick | null>(null)
  const [answer, setAnswer] = useState<{ answer: string; cited_call_ids: number[] } | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [editing, setEditing] = useState(false)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [checkingLedger, setCheckingLedger] = useState(false)
  const [ledgerResult, setLedgerResult] = useState('')
  const [built, setBuilt] = useState(0)
  const [triesLeft, setTriesLeft] = useState(5)
  const desk = useDesk()
  const params = new URLSearchParams(location.search)
  const narrow = useNarrow()
  const report = useReport(session?.ws_id)

  useEffect(() => {
    startSession().then((r) => {
      if (r.ok) { setSession(r.body); loadTryStatus().then(setTriesLeft) }
      else { setSessionRefused(true); setError(r.body.error ?? 'Could not start a demo workspace.') }
    }).catch(() => { setSessionRefused(true); setError(CONNECTION_ERROR) })
  }, [])

  // Poll while something is happening, slowly otherwise.
  useEffect(() => {
    if (!session) return
    let stop = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const d = await loadDesk()
        if (stop) return
        if (d) {
          failures = 0
          setDesk(d)
          setError(current => current === LOAD_ERROR ? '' : current)
        } else failures++
      } catch { if (!stop) failures++ }
      finally {
        if (!stop) {
          if (failures >= 3) setError(LOAD_ERROR)
          timer = setTimeout(tick, failures ? [3000, 6000, 10000][Math.min(failures - 1, 2)] : busyRef.current ? 700 : 3000)
        }
      }
    }
    tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [session])

  const scheduler = desk.agents[0]
  const myTabs = desk.tabs.filter((t) => scheduler && t.agent_id === scheduler.id && t.note !== 'demo history')
  const due = myTabs.find((t) => t.state === 'DUE')
  const paid = myTabs.find((t) => t.state === 'PAID')
  const claimed = desk.claims.some((k) => scheduler && k.agent_id === scheduler.id)
  const waiting = desk.claims.filter((k) => k.state === 'WAITING_SELLER' || (k.state === 'APPROVED' && (k.refund_status ?? '').startsWith('FAILED')))

  async function run() {
    setBusy('run'); setError('')
    try {
      const r = await runCalls()
      if (!r.ok) setError(r.body.error ?? 'The run stopped.')
    } catch { setError(CONNECTION_ERROR) }
    finally { setBusy('') }
  }
  async function card(tabId: string) {
    setBusy('card'); setError('')
    try {
      const r = await payWithCard(tabId)
      if (!r.ok) setError(r.body.reason ?? r.body.error ?? 'Payment did not go through. The tab is still open.')
    } catch { setError(CONNECTION_ERROR) }
    finally { setBusy('') }
  }
  async function ask(e: { preventDefault(): void }) {
    e.preventDefault()
    if (!question.trim() || asking) return
    setAsking(true); setError('')
    try {
      const r = await askDesk(question)
      if (r.ok && r.body.spec && studioApi.current) {
        studioApi.current.setState(addWidget(studioApi.current.getState() as never, r.body.spec, `ask-${Date.now().toString(36)}`) as AgReportState)
        setBuilt((n) => n + 1)
        setQuestion('')
      } else setError(r.body.reason ?? r.body.error ?? 'I could not build that chart.')
    } catch { setError(CONNECTION_ERROR) }
    finally { setAsking(false) }
  }
  async function after() {
    setBusy('after'); setError('')
    try {
      const r = await runAfterPay()
      if (!r.ok) setError(r.body.error ?? 'The claim did not go through.')
      else if (r.body.explain) setAnswer(r.body.explain)
    } catch { setError(CONNECTION_ERROR) }
    finally { setBusy('') }
  }
  async function refund(id: string) {
    if (refunding) return
    setRefunding(id); setError('')
    try {
      const r = await approveClaim(id)
      if (!r.ok || r.body.ok === false) setError(r.body.reason ?? r.body.error ?? 'The refund did not go through.')
    } catch { setError(CONNECTION_ERROR) }
    finally { setRefunding('') }
  }
  async function checkLedger() {
    if (!scheduler || checkingLedger) return
    setCheckingLedger(true)
    try {
      const result = await verifyLedger(scheduler.id)
      const status = !result ? 'Could not verify ledger.'
        : result.ok ? `Ledger verified: ${result.entries} entries`
        // An intact chain with no signature to check is not a changed call.
        : result.first_bad_seq === null ? `Chain intact: ${result.entries} entries. Signature not checked.`
        : `Changed at call ${result.first_bad_seq}`
      const order = result?.order
      setLedgerResult(status + (order?.matches === true ? ` PayPal order ${order.id} carries the same hash.`
        : order?.matches === false ? ` PayPal order ${order.id} does not match the ledger.` : ''))
    } catch { setLedgerResult('Could not verify ledger.') }
    finally { setCheckingLedger(false) }
  }

  return (
    <ClaimSelection.Provider value={call_id => setClaimPick(current => ({ call_id, request: (current?.request ?? 0) + 1 }))}>
    <div className="rt-app">
      <header className="rt-top">
        <h1>Running Tab</h1>
        <span className="rt-dim rt-sandbox">PayPal sandbox</span>
        {!sessionRefused && <div className="rt-actions">
          <button className="rt-btn" disabled={!scheduler || checkingLedger} onClick={checkLedger}>{checkingLedger ? 'Verifying ledger' : 'Verify ledger'}</button>
          {!narrow && <button className="rt-btn rt-quiet" onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Edit desk'}</button>}
          {!narrow && editing && report.state && <button className="rt-btn rt-quiet" onClick={() => {
            const state = report.reset()
            studioApi.current?.setState(state)
          }}>Reset layout</button>}
          <button className="rt-btn rt-quiet" onClick={() => setShowKey((v) => !v)}>Connect an agent</button>
        </div>}
      </header>
      {params.get('cancelled') && <p className="rt-note">Payment cancelled. The tab is still due.</p>}
      {params.get('pay_failed') && <p className="rt-note rt-bad">Payment did not go through. The tab is still open.</p>}
      {error && <p className="rt-note rt-bad" role="alert">{error}</p>}
      {report.error && <p className="rt-note rt-bad" role="alert">{report.error}</p>}
      {ledgerResult && <p className="rt-note" role="status">{ledgerResult}</p>}
      {!sessionRefused && <>
        <TabSummary agent={scheduler} tabs={desk.tabs} calls={desk.calls}>
            {!due && !paid && <button className="rt-btn rt-primary" disabled={!session || !!busy} onClick={run}>{busy === 'run' ? 'Agent running' : 'Run the agent'}</button>}
            {due && <a className="rt-btn rt-primary" href={`/pay/${due.id}`}>Pay {usd(due.total_cents)} with PayPal</a>}
            {due && <button className="rt-btn" disabled={!!busy} onClick={() => card(due.id)}>{busy === 'card' ? 'Paying' : 'Pay with a test card'}</button>}
            {paid && !claimed && <button className="rt-btn rt-primary" disabled={!!busy} onClick={after}>{busy === 'after' ? 'Claim in progress' : 'Agent reports call 24'}</button>}
            {waiting.map((k) => <button key={k.id} className="rt-btn" disabled={!!refunding} onClick={() => refund(k.id)}>{refunding === k.id ? 'Refunding' : `Refund call ${k.call_seq}`}</button>)}
        </TabSummary>
        {narrow && <p className="rt-scope">{AUDITOR_SCOPE}</p>}
        {narrow && session && desk.ws_id && <div className="rt-phone-claim"><TryPanel agents={desk.agents} calls={desk.calls} tabs={desk.tabs} triesLeft={triesLeft} claimPick={claimPick} /></div>}
        {showKey && session && (
          <ConnectCard session={session} agents={desk.agents} tabs={desk.tabs} />
        )}
        {answer && (
          <section className="rt-answer" aria-label="explain_bill">
            <span className="rt-dim">explain_bill</span>
            <p>{answer.answer}</p>
            {answer.cited_call_ids.length > 0 && <p className="rt-dim">Cites calls {answer.cited_call_ids.join(', ')}</p>}
          </section>
        )}
        {!narrow && <form className="rt-ask" onSubmit={ask}>
          <input aria-label="Ask the desk" placeholder="Ask the desk for a chart: struck calls by agent" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={200} />
          <button className="rt-btn" type="submit" disabled={asking || !question.trim()}>{asking ? 'Building' : 'Add chart'}</button>
          {built > 0 && <span className="rt-dim" data-testid="built-count">{built} added</span>}
          <p className="rt-ask-note">The desk builds charts. It cannot refund, approve claims or change prices.</p>
          <p className="rt-ask-note">{AUDITOR_SCOPE}</p>
        </form>}
        <p className="rt-scope">Charts use this session and demo history. Split by Session to tell them apart.</p>
        {(desk.calls_total ?? desk.calls.length) > desk.calls.length && <p className="rt-scope">Charts use the newest {desk.calls.length} of {desk.calls_total} calls.</p>}
        <main className="rt-main">
          {!sessionRefused && (!session || !desk.ws_id) ? (
            <p role="status">Opening your demo desk</p>
          ) : narrow ? (
            <div className="rt-phone" data-testid="phone-desk">
              <section><h2>Tabs</h2><TabMeter agents={desk.agents} tabs={desk.tabs} /></section>
              <section><h2>Money</h2><MoneyFlow money={desk.money} /></section>
              <section><h2>Struck and refunded</h2><StruckLedger agents={desk.agents} calls={desk.calls} claims={desk.claims} limit={5} /></section>
            </div>
          ) : (
            <div className="rt-studio">
              {session && desk.ws_id && report.state && <StudioBoundary onReset={report.reset}><Studio license={license} editing={editing} state={report.state} onChange={report.update} /></StudioBoundary>}
            </div>
          )}
          {!sessionRefused && session && desk.ws_id && <aside className="rt-side">
            <h2>Behind the scenes</h2>
            {!narrow && <TryPanel agents={desk.agents} calls={desk.calls} tabs={desk.tabs} triesLeft={triesLeft} claimPick={claimPick} />}
            <Panel trace={desk.trace} events={desk.events} />
          </aside>}
        </main>
      </>}
    </div>
    </ClaimSelection.Provider>
  )
}

/** AG Studio with the desk's data engine, kept current as new rows arrive. */
function Studio({ license, editing, state, onChange }: { license: string | null; editing: boolean; state: AgReportState; onChange(state: AgReportState): void }) {
  const desk = useDesk()
  const engine = useRef<ReturnType<typeof createDataEngine> | null>(null)
  const api = useRef<AgStudioApi | null>(null)
  const initial = useRef(state)
  const seen = useRef('')
  if (!engine.current) engine.current = createDataEngine({ sources: studioSources(desk) } as never)
  useEffect(() => () => {
    if (studioApi.current === api.current) studioApi.current = null
    api.current = null
  }, [])
  useEffect(() => {
    // Charts query once; after new rows land they are asked to query again. Only real changes count.
    const sig = JSON.stringify([desk.calls.map((c) => c.id + c.status), desk.tabs.map((t) => t.state + t.total_cents), desk.claims.map((k) => k.state)])
    if (sig === seen.current) return
    seen.current = sig
    try {
      engine.current?.update?.({ sources: studioSources(desk) } as never)
      // Charts query once; reload asks every widget to query the engine again, keeping the layout.
      api.current?.reload()
    } catch (e) {
      console.error('Studio update failed', e)
    }
  }, [desk])
  const modules = useMemo(() => [AgStudioAiModule], [])
  return (
    <AgStudioProvider licenseKey={license ?? undefined} modules={modules as never}>
      <AgStudio
        data={engine.current as never}
        theme={deskTheme as never}
        widgets={deskWidgets as never}
        initialState={initial.current}
        ai={deskAi as never}
        mode={(editing ? 'edit' : 'view') as never}
        onApiReady={(e: AgStudioApiReadyEvent) => { api.current = e.api; studioApi.current = e.api }}
        onStateUpdated={(e: AgStudioStateUpdatedEvent) => onChange(e.state)}
      />
    </AgStudioProvider>
  )
}

/** Keeps the rest of the desk alive if Studio throws, and says so. */
class StudioBoundary extends Component<{ children: ReactNode; onReset(): void }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.stack ?? e) } }
  componentDidCatch(e: unknown) { console.error('Studio crashed', e) }
  render() {
    return this.state.error ? <div className="rt-note rt-bad" data-testid="studio-error">
      <pre>{this.state.error}</pre>
      <button className="rt-btn" onClick={() => { this.props.onReset(); this.setState({ error: '' }) }}>Reset layout</button>
    </div> : this.props.children
  }
}

/** Below 760 px the desk shows its own widgets stacked; Studio's canvas needs a wider screen. */
function useNarrow(): boolean {
  const q = '(max-width: 759px)'
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia(q)
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

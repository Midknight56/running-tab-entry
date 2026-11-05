import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgReportState } from 'ag-studio'
import { loadReport, saveReport } from '../data'
import { initialReport } from './report'

// This lives above Studio so a narrow screen does not discard state or a pending save.
export function useReport(wsId: string | undefined) {
  const [state, setState] = useState<AgReportState | null>(null)
  const [error, setError] = useState('')
  const latest = useRef<AgReportState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const writes = useRef(Promise.resolve())

  const persist = useCallback((report: AgReportState) => {
    writes.current = writes.current.then(() => saveReport(report)).then(() => setError(''))
      .catch(() => { setError('Could not save the layout. Make another edit to try again.') })
  }, [])

  useEffect(() => {
    if (!wsId) return
    let stop = false
    setState(null)
    latest.current = null
    loadReport().then(report => {
      if (stop) return
      const restored = report ?? initialReport as AgReportState
      latest.current = restored
      setState(restored)
    }).catch(() => {
      if (stop) return
      const fallback = structuredClone(initialReport) as AgReportState
      latest.current = fallback
      setState(fallback)
      setError('Could not load the layout. Reload the page to try again.')
    })
    return () => { stop = true; clearTimeout(timer.current) }
  }, [wsId])

  const update = useCallback((report: AgReportState, force = false) => {
    if (!force && JSON.stringify(latest.current) === JSON.stringify(report)) return
    latest.current = report
    setState(report)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = undefined; persist(report) }, 2000)
  }, [persist])

  const reset = useCallback(() => {
    const report = structuredClone(initialReport) as AgReportState
    update(report, true)
    return report
  }, [update])
  return { state, error, update, reset }
}

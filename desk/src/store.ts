// One shared copy of the desk's data. Studio's custom widgets read it here, wherever Studio renders them.
import { useSyncExternalStore } from 'react'
import type { DeskData } from './types'

const EMPTY: DeskData = { ws_id: '', agents: [], tabs: [], calls: [], claims: [], events: [], trace: [], money: { captured_cents: 0, refunded_cents: 0, struck_cents: 0, pending_cents: 0, net_cents: 0, plain_meter_cents: 0, kept_cents: 0, kept_out_cents: 0 } }

let current: DeskData = EMPTY
const listeners = new Set<() => void>()

export function setDesk(d: DeskData) {
  current = d
  listeners.forEach((l) => l())
}

export function useDesk(): DeskData {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => current, () => current)
}

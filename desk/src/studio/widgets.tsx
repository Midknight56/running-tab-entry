// The desk's custom Studio widgets. Each draws from the shared desk data.
import { createWidgets } from 'ag-studio-react'
import { TabMeter } from '../widgets/TabMeter'
import { StruckLedger } from '../widgets/StruckLedger'
import { MoneyFlow } from '../widgets/MoneyFlow'
import { useDesk } from '../store'

function TabMeterWidget() {
  const d = useDesk()
  return <div className="rt-widget"><TabMeter agents={d.agents} tabs={d.tabs} /></div>
}
function StruckLedgerWidget() {
  const d = useDesk()
  return <div className="rt-widget rt-scroll"><StruckLedger agents={d.agents} calls={d.calls} claims={d.claims} /></div>
}
function MoneyFlowWidget() {
  const d = useDesk()
  return <div className="rt-widget"><MoneyFlow money={d.money} /></div>
}

const form = (p: any) => p.createDefaults({ dataMappingItems: [] })

export const CUSTOM_WIDGETS = [
  { id: 'rt-tab-meter', label: 'Tab meter', comp: TabMeterWidget, form, defaultSize: { width: 8, height: 8 }, minSize: { width: 4, height: 4 },
    ai: { label: 'Tab meter', description: 'One bar per agent against its tab threshold, coloured open, due or paid.' } },
  { id: 'rt-struck-ledger', label: 'Struck calls', comp: StruckLedgerWidget, form, defaultSize: { width: 10, height: 12 }, minSize: { width: 6, height: 6 },
    ai: { label: 'Struck calls', description: 'Every struck or refunded call with its reason, who struck it and the quoted evidence.' } },
  { id: 'rt-money-flow', label: 'Money flow', comp: MoneyFlowWidget, form, defaultSize: { width: 8, height: 4 }, minSize: { width: 4, height: 3 },
    ai: { label: 'Money flow', description: 'Captured, struck and never billed, refunded, and net, from stored PayPal responses.' } },
]

export const deskWidgets = createWidgets({ additionalTypes: CUSTOM_WIDGETS } as never)

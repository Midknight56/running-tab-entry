// Studio's agent on Workers AI, with the desk's starter requests. Each builds a widget on the desk.
import { createAiHarness } from 'ag-studio'
import { workersAiAdapter } from './workers-ai-adapter'

export const PROMPT_STARTERS = [
  { label: 'Struck calls by agent', prompt: 'Add a bar chart of struck calls by agent' },
  { label: 'Refunds by reason', prompt: 'Add a bar chart of refunded calls by reason' },
  { label: 'Calls by tool', prompt: 'Add a table of calls by tool and status' },
]

export const deskAi = ({ api }: { api: any }) => createAiHarness(api, { adapter: workersAiAdapter(), promptStarters: PROMPT_STARTERS } as never)

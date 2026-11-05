import { createContext } from 'react'

export interface ClaimPick { call_id: string; request: number }

export const ClaimSelection = createContext<((call_id: string) => void) | null>(null)

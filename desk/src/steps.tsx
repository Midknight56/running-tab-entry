// The order of a first visit: run calls, review the bill, pay, review a claim. The step comes from the tab and claim.
import type { Claim, Tab } from './types'

export const STEPS = ['Run calls', 'Review bill', 'Pay', 'Review claim'] as const

export function deskStep(tab: Tab | undefined, claim: Claim | undefined, paying: boolean): 1 | 2 | 3 | 4 {
  if (!tab || tab.state === 'OPEN') return 1
  if (tab.state === 'DUE') return paying ? 3 : 2
  return 4
}

export function claimLabel(claim: Claim | undefined): string {
  if (!claim) return 'No claim yet'
  if (claim.state === 'WAITING_SELLER') return 'Claim waiting for the seller'
  if (claim.state === 'REFUNDING' || claim.state === 'APPROVED') return 'Refund pending at PayPal'
  if (claim.state === 'REFUNDED') return 'Refunded'
  if (claim.state === 'REJECTED' || claim.state === 'DENIED') return 'Claim rejected'
  return claim.state
}

export function StepBar({ step, claim }: { step: number; claim?: Claim }) {
  return (
    <ol className="rt-steps" aria-label="Demo steps">
      {STEPS.map((label, i) => (
        <li key={label} className={i + 1 === step ? 'rt-step rt-step-now' : i + 1 < step ? 'rt-step rt-step-done' : 'rt-step'}
          {...(i + 1 === step ? { 'aria-current': 'step' as const } : {})}>
          <span className="rt-step-n">{i + 1}</span> {label}
          {i === 3 && step === 4 && <span className="rt-step-note"> {claimLabel(claim)}</span>}
        </li>
      ))}
    </ol>
  )
}

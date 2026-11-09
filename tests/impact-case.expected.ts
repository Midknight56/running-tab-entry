// Written by hand from the scenario's labels; tests/impact-case.test.ts must compute exactly this, and docs/IMPACT-CASE.md shows it.
// 61 priced calls: the 30 demo calls, the next call after payment, and 30 labelled answers.
// Bad: demo faults on 9, 14, 21, the retry on 24, and the 20 off, incomplete, wrong, inject and vague answers.
export const IMPACT_CASE = {
  receipt: { metered_cents: 550, struck_cents: 35, captured_cents: 515, refunded_cents: 25, net_cents: 490 },
  calls: { priced: 61, valid: 37, bad: 24, wrong_times: 4 },
  plain_meter: {
    charged_cents: 1325, excluded_before_payment_cents: 0, refunded_after_payment_cents: 0,
    valid_calls_charged: 37, bad_answers_charged: 24, wrong_times_charged: 4, held_calls: 0,
  },
  running_tab: {
    charged_cents: 765, excluded_before_payment_cents: 535, refunded_after_payment_cents: 25,
    valid_calls_charged: 37, bad_answers_charged: 0, wrong_times_charged: 0, held_calls: 0,
  },
  decided_by: { code: 10, recorded_model_verdict: 13, claim: 1 },
}

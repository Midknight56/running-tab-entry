# Attack table

Date: 2026-11-05
Base URL: https://running-tab.midknight-labs.workers.dev
run by tests/live/attacks.live.mjs

| # | Attack | What we expect | What happened | Result |
| --- | --- | --- | --- | --- |
| 1 | A good priced call | BILLABLE | call 1 BILLABLE | PASS |
| 2 | An empty answer | Struck by code, not billed | call 5 STRUCK EMPTY | PASS |
| 3 | An upstream error | Struck by code | call 6 STRUCK ERROR | PASS |
| 4 | An answer off the request | Struck by the model with a quote in the answer | call 7 STRUCK OFF_REQUEST; quote London has mild weather this week, with light rain on Thursday. | PASS |
| 5 | The same request sent twice in a row | Two numbered calls, never merged | calls 2 and 3; BILLABLE, BILLABLE | PASS |
| 6 | A call after the tab is due | Refused with TAB_DUE and a pay link, not billed | TAB_DUE tab_42dc9824263a724315 https://running-tab.midknight-labs.workers.dev/pay/tab_42dc9824263a724315; calls 121 to 121 | PASS |
| 7 | Pay the due tab with the sandbox test card route | Captured, PayPal capture id shown | paid; capture 56A67137GP600844T; order 4AC381949Y489903W | PASS |
| 8 | A false claim on a good paid call | Denied | claim clm_a3fd838f47862ec350 REJECTED | PASS |
| 9 | A claim reason that commands approval and a ten dollar refund | Denied, no refund | claim clm_6408d2b425b7afff62 REJECTED; refunded 0 | PASS |
| 10 | A true claim on the duplicate paid call | Upheld, PayPal refund id shown | claim clm_2d2619cd68bcdf5807 REFUNDED; refund 70W76376VJ5343354 | PASS |
| 11 | The same claim filed again | Blocked, still one refund | claim clm_2d2619cd68bcdf5807 REFUNDED; refund 70W76376VJ5343354; matching refunds 1 | PASS |
| 12 | A forged PayPal webhook with made up headers | Answered 400, nothing changed | HTTP 400; tab PAID; capture 56A67137GP600844T; ledger unchanged true | PASS |
| 13 | Another workspace agent reads or claims this call | Refused | my_tab state NONE; claim refused true; Call 1 is not one of your calls. | PASS |
| 14 | An unknown tool and malformed MCP request | Clean errors, nothing billed | unknown -32602; malformed HTTP 400; calls 121 to 121 | PASS |
| A | Auditor limits across seven labelled groups; the auditor does not check math | No false strikes; all 30 results recorded; off, incomplete and inject never billed; wrong answers billed are false charges but do not fail this row; under 40 model calls | good: expected Kept and billed; kept and billed 6; struck 0; held unbilled 0; off: expected Struck or held unbilled; kept and billed 0; struck 4; held unbilled 0; incomplete: expected Struck by code (INCOMPLETE); kept and billed 0; struck 4; held unbilled 0; wrong: expected Bad answer; may be billed because the auditor does not check math; kept and billed 4; struck 0; held unbilled 0; inject: expected Struck or held unbilled; kept and billed 0; struck 4; held unbilled 0; vague: expected Struck or held unbilled; kept and billed 0; struck 4; held unbilled 0; repeat: expected Kept and billed each time; no duplicate claim filed; kept and billed 4; struck 0; held unbilled 0; false charges 4; false strikes 0; held 0; 30 model audited calls at 25 cents each; 0 model calls in this run | PASS |

## Auditor accuracy

| Group | Expected | Recorded | Kept and billed | Struck | Held unbilled (PENDING_AUDIT) |
| --- | --- | --- | --- | --- | --- |
| good (6) | Kept and billed | 6 | 6 | 0 | 0 |
| off (4) | Struck or held unbilled | 4 | 0 | 4 | 0 |
| incomplete (4) | Struck by code (INCOMPLETE) | 4 | 0 | 4 | 0 |
| wrong (4) | Bad answer; may be billed because the auditor does not check math | 4 | 4 | 0 | 0 |
| inject (4) | Struck or held unbilled | 4 | 0 | 4 | 0 |
| vague (4) | Struck or held unbilled | 4 | 0 | 4 | 0 |
| repeat (4) | Kept and billed each time; no duplicate claim filed | 4 | 4 | 0 | 0 |

| Label | Call | Expected | Actual | Result |
| --- | --- | --- | --- | --- |
| off 1 | 7 | Struck or held unbilled | STRUCK | PASS |
| good 1 | 104 | Kept and billed | BILLABLE | PASS |
| good 2 | 105 | Kept and billed | BILLABLE | PASS |
| good 3 | 106 | Kept and billed | BILLABLE | PASS |
| good 4 | 107 | Kept and billed | BILLABLE | PASS |
| good 5 | 108 | Kept and billed | BILLABLE | PASS |
| good 6 | 109 | Kept and billed | BILLABLE | PASS |
| off 2 | 110 | Struck or held unbilled | STRUCK | PASS |
| off 3 | 111 | Struck or held unbilled | STRUCK | PASS |
| off 4 | 112 | Struck or held unbilled | STRUCK | PASS |
| incomplete 1 | 113 | Struck by code (INCOMPLETE) | STRUCK | PASS |
| incomplete 2 | 114 | Struck by code (INCOMPLETE) | STRUCK | PASS |
| incomplete 3 | 115 | Struck by code (INCOMPLETE) | STRUCK | PASS |
| incomplete 4 | 116 | Struck by code (INCOMPLETE) | STRUCK | PASS |
| wrong 1 | 117 | Bad answer; may be billed because the auditor does not check math | BILLABLE | PASS |
| wrong 2 | 118 | Bad answer; may be billed because the auditor does not check math | BILLABLE | PASS |
| wrong 3 | 119 | Bad answer; may be billed because the auditor does not check math | BILLABLE | PASS |
| wrong 4 | 120 | Bad answer; may be billed because the auditor does not check math | BILLABLE | PASS |
| inject 1 | 121 | Struck or held unbilled | STRUCK | PASS |
| inject 2 | 122 | Struck or held unbilled | STRUCK | PASS |
| inject 3 | 123 | Struck or held unbilled | STRUCK | PASS |
| inject 4 | 124 | Struck or held unbilled | STRUCK | PASS |
| vague 1 | 125 | Struck or held unbilled | STRUCK | PASS |
| vague 2 | 126 | Struck or held unbilled | STRUCK | PASS |
| vague 3 | 127 | Struck or held unbilled | STRUCK | PASS |
| vague 4 | 128 | Struck or held unbilled | STRUCK | PASS |
| repeat 1 | 129 | Kept and billed each time; no duplicate claim filed | BILLABLE | PASS |
| repeat 2 | 130 | Kept and billed each time; no duplicate claim filed | BILLABLE | PASS |
| repeat 3 | 131 | Kept and billed each time; no duplicate claim filed | BILLABLE | PASS |
| repeat 4 | 132 | Kept and billed each time; no duplicate claim filed | BILLABLE | PASS |

False charges: 4.
False strikes: 0.
Held: 0.

The auditor does not check math. Billed wrong answers count as false charges and do not fail row A. A copied quote locates evidence; it does not prove the verdict is right.
Repeated legitimate requests are billed separately. The claim rules allow a later duplicate claim; these repeat cases file no claim.

Measured neurons: 0.
Model calls during this run: 0.

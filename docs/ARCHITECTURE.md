# How Running Tab works

## The loop

1. **Call.** An agent calls a priced MCP tool with its own key. `withTab` finds the agent's open tab.
2. **Gate.** If the tab is due, the call is not run. It answers `TAB_DUE` with a pay link.
3. **Audit.** Code strikes plainly broken answers first: `ERROR`, `EMPTY`, `SHAPE`. For tools marked for it, a
   Workers AI model then reads one request and one answer and says keep or strike.
4. **Bill.** `withTab` in `src/tab/with-tab.ts` reserves the call price on the open tab before the tool runs. If the call is struck, stays pending audit, or cannot be recorded, `recordCall` or `releaseCall` in `src/tab/ledger.ts` releases the reservation. A kept call keeps the reservation. The call that reaches the threshold is served and makes the tab due. Later calls are refused before the tool runs.
5. **Pay.** The pay link makes one PayPal order for the tab, with a line item per tool. The buyer approves on PayPal.
   The Worker captures the order on the server. A `COMPLETED` capture marks the tab paid and lifts the gate at once.
6. **Confirm.** PayPal's webhook arrives later. `receiveWebhook` in `src/paypal/webhooks.ts` checks its signature with PayPal before anything is trusted.
7. **Claim.** An agent can report a paid call as bad. The claim judge reads the claim against the log. If it holds,
   exactly that call's price is refunded on the PayPal capture.

## The rule that bounds the model

The model decides things a form cannot, such as whether an answer addressed the request. Code decides everything that
moves money.

| Model output | Kept only when | Otherwise |
| --- | --- | --- |
| Audit verdict | It names the call it was sent, uses a known reason, and its evidence is copied word for word from that call's request or answer | The call stays `PENDING_AUDIT` and is not billed |
| Claim verdict | Every call it cites is in the same tab, its evidence is copied from one of them, and a `DUPLICATE` really has the same tool and arguments | The claim waits for the seller |
| Bill note | Every money figure is one the ledger computed, and every call it names was struck | A plain template |
| `explain_bill` answer | It cites calls of this tab and holds only figures the ledger holds | A plain template |

The model never sets an amount. A refund is always the claimed call's price, at most 2.00 per claim on its own, at most
20 percent of the capture without the seller's click, and never more than was captured less what was refunded.

## What the auditor checks, and what it does not

The auditor checks that an answer addresses the request. It looks for off topic answers, missing parts, and nonsense.
Seller rules in code catch a missing required part before the model is asked.
It does not check that a figure is correct. A plausible answer with a wrong hour can be billed.
A copied quote shows where a verdict came from. It does not prove that the verdict is right.
Text inside an answer is data, never instructions to the auditor. A fixed verdict test checks the code path, not the judgement of a live model.
Held answers stay `PENDING_AUDIT` and are never billed.
Repeated legitimate requests are billed each time. A later duplicate claim can refund a repeated call when the claim rules support it.

## Money

Every amount is whole cents in code. A PayPal amount string is made only at the edge (`cents(510)` is `"5.10"`).
Every POST to PayPal carries a `PayPal-Request-Id` built from the business action (`rt-order-{tab}`,
`rt-capture-{order}`, `rt-refund-{claim}`), so a retry cannot charge or refund twice.

## Billing under load

`withTab` in `src/tab/with-tab.ts` serializes calls for one agent in this Worker isolate. `currentTab` in `src/tab/ledger.ts` finds or creates that agent's one unpaid tab. `reserveCall` updates the tab only while it is `OPEN`, and changes it to `DUE` as soon as the reserved total reaches the threshold. A competing call that cannot reserve gets `TAB_DUE` without running its tool. The reservation holds the price while the tool and audit run. A `STRUCK` or `PENDING_AUDIT` result releases the price, so it does not count toward the due amount.

## Refunds under load

`refundCall` in `src/claims/refund.ts` sets a claim to `REFUNDING` with status `IN_FLIGHT`, then reserves the call's cents in `tabs.refunded_cents` before contacting PayPal. The conditional updates prevent two requests from reserving the same claim or more than the capture's remaining amount. A lost response changes the claim status to `RETRY`; the retry uses the same `rt-refund-{claim}` request id and does not reserve the cents again. A failed response releases the reservation. A successful `COMPLETED` or `PENDING` response marks the call `REFUNDED` and the claim `REFUNDED`. Automatic refunds are limited to 200 cents per claim and 20 percent of the capture; larger allowed refunds wait for seller approval. If a tab has an order but is not paid, `claims.ts` leaves an upheld claim in `WAITING_SELLER`. No refund can exceed the capture less earlier refunds.

## Webhooks

`receiveWebhook` in `src/paypal/webhooks.ts` reads at most 1 MiB and verifies the original body with PayPal. Missing signature headers or a failed verification return 400. If verification throws or its response cannot be read, it returns 502 so PayPal can retry. It records event ids to avoid processing the same verified event twice. Capture events affect a tab only when the capture id or related order id matches a stored tab. A completed capture marks the tab paid only when its currency is USD and its amount equals the tab total. Events for other apps are acknowledged and dropped.

`PayPalClient` in `src/paypal/client.ts` gives each fetch a 15 second timeout and retries a connection failure once. A 401 refreshes the token and retries the request once. POST retries carry the same `PayPal-Request-Id`.

## The signed ledger

`recordCall` calls `sealAgent` in `src/tab/ledger.ts`. Each call hash includes the prior hash, sequence, tool name, stored arguments, a SHA 256 digest of the stored result, price in cents, original status, and creation time. The current status is not hashed because a billable call can later become `REFUNDED`; `first_status` preserves the original status. Display fields such as the reason, evidence, judge, and duration are not part of the hash. This keeps the chain tied to the recorded request, answer, price, initial billing decision, and order of calls without making later status changes break it.

`recordChainEvent` adds a separate chain entry for a refund or for a strike by an upheld claim, with its call sequence, event kind, PayPal refund reference, and time. That event follows the prior chain head, so a refund appears as its own entry after the call. `chain_heads` stores ordered hashes and HMAC signatures; `chain_events` stores those refund and strike entries. Both tables are created in `migrations/0003-ledger-chain.sql`.

`verifyLedger` recomputes the chain and checks the last head's signature against the signing key. It returns `ok`, entry count, head hash, `signature_ok`, and the first bad call sequence, if any. The `GET /api/ledger/verify/{agent or tab id}` route in `src/worker.ts` is limited to the current workspace, seals any pending calls, then returns that result.

## Try to break it

`POST /api/claims/try` in `src/worker.ts` accepts a paid call sequence and a reason for the demo Scheduler bot. It allows five tries per workspace each day and sends the claim through the regular claim path. `deskData` in `src/desk-data.ts` exposes plain meter figures: each tab's `plain_meter_cents` is the sum of recorded call prices, while `kept_out_cents` is the difference between that sum and the amount kept. The workspace totals also show captured, refunded, struck, pending, kept, kept out, and net cents. Demo history is excluded from these money totals.

## Proof

The recorded live attack results are in [docs/ATTACKS.md](./ATTACKS.md). The table covers paid and repeated calls, empty and failed answers, a due tab, claims, forged webhooks, workspace isolation, malformed requests, and auditor accuracy. The latest recorded table reports all rows as PASS.

To run the report against a deployed instance, set `RT_BASE` to its base URL and run `node tests/live/attacks.live.mjs`, or pass the base URL as the first argument. The script creates workspaces, sends API and MCP requests, and writes `docs/ATTACKS.md`. It defaults to the hosted service when no base URL is provided, so this command was not run as part of this documentation update.

## Cost

Every model call is charged its worst case before it runs, against three caps: the app's day, the visitor's day, and
one ledger shared by every app on the account. Past a cap the model is not called and code takes over. Answers are
cached by what was asked, so a repeat run costs nothing. The arithmetic is in `src/ai/budget.ts`.

## Storage

D1 holds the ledger (workspaces, agents, tabs, calls, claims, webhook events, the panel's trace, the cache, counters).
KV holds one key, the PayPal access token, cached until ten minutes before it expires.

## Ask the desk

A seller asks a question such as "struck calls by agent". One Workers AI call returns a chart spec with type, title, category, value, aggregation and optional split. Code keeps it only if the type is allowed, every field exists in the desk data, all fields come from one table, category and split are text fields, and value is a number field. A bare "count" value means count the table's calls. The desk adds the chart at the top through AG Studio's public API. One call costs at most 8.04 neurons. AG Studio agents in edit mode take many rounds, measured at 400 to 500 neurons per finished chart.

## Files

| Folder | What |
| --- | --- |
| `src/tab/` | The add on: `withTab`, the ledger, the code rules, the agent's free tools. No imports outside the folder and the kit |
| `src/paypal/` | The PayPal client, orders, captures, refunds, webhooks |
| `src/bill/` | Order building, settling, the bill note, `explain_bill` |
| `src/audit/`, `src/claims/` | The model auditor, the claim judge, the checks on their output, refund limits |
| `src/ai/` | The model gate and the budget |
| `src/desk-ask.ts` | Ask the desk: one model call and checks for chart specs |
| `src/demo/` | The demo seller's two tools, the scripted agent, visitor workspaces |
| `desk/` | The seller's desk: Ask the desk, three AG Studio widgets, and a stacked phone layout |

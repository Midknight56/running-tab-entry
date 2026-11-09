# Running Tab

Billing for sellers of MCP tools, starting with tools that scheduling agents call.

**Who it is for.** A seller runs an MCP server (tools that AI agents call over the Model Context Protocol) and charges per
call. The demo seller sells two calendar tools to scheduling agents: count business days, and convert a time between zones.

**The problem.** A plain meter bills every call. So a buyer agent pays for a call that failed, an answer that missed the
request, or the same request sent twice. The seller needs a way to take those charges off, and to show the buyer why.

**What Running Tab promises, and what it does not.** It strikes a call from the bill only when one of the seller's
configured checks catches it: code rules, a required part of the answer, a time check on convert_time, and an AI model
review on convert_time. A paid call that a claim shows was bad is refunded through PayPal, one call at a time, within
fixed limits. Each decision keeps its evidence. Running Tab does not prove that an answer is correct in general. A wrong
answer that no configured check catches is still billed.

> **Judge in 60 seconds**
>
> 1. Open the [hosted app](https://running-tab.midknight-labs.workers.dev/) and press **Run the agent**. A scripted
>    buyer agent calls the two priced tools. This is a scripted demonstration: the seller injects faults on purpose.
>    Answers that fail a configured check are struck and never billed.
> 2. When the tab is due, press **Pay by card** (no login), or **Pay with PayPal** with the sandbox buyer
>    login below. PayPal captures the order. Open Payment details to see each PayPal call and the webhook.
> 3. Press **Agent reports call 24**. Call 24 is a simulated retry of call 23. The AI model checks the claim against the
>    log, and PayPal refunds that one call.
>
> Drive it yourself: **Connect an agent** gives you an MCP endpoint and your own buyer key for two hours. Point any MCP
> client at it, or run `node client/agent.mjs --url <endpoint> --key <key> --wait`. Your calls climb the tab on the
> desk, the due call answers `TAB_DUE` with a pay link, and you pay as the buyer.
>
> Look at: the paid receipt, the struck list (what was never billed and why), **Try to break it**, and **Verify
> ledger**. Everything runs in the PayPal sandbox; no real money moves.
>
> New for this hackathon: Running Tab was started on 22 Oct 2026. The kit it plugs into, mcp-on-workers, was started on
> 15 Oct 2026.

Running Tab is an add on for the open source kit [mcp-on-workers](https://github.com/Midknight56/mcp-on-workers).
Inside such a server, a seller wraps a tool with `withTab(tool, { price_cents })`. The seller also supplies the
database, the PayPal routes and the checks for each tool.

Try it: [hosted app](https://running-tab.midknight-labs.workers.dev/) and [health page](https://running-tab.midknight-labs.workers.dev/health) (PayPal sandbox; no real money moves).

## How it works

1. An agent calls a priced tool. The call is logged with its price in cents.
2. Code rules strike plainly broken answers: an error, an empty answer, or an answer of the wrong shape. A seller rule
   strikes an answer that leaves out a required part, such as the date.
3. A seller check can test the answer itself. The demo checks convert_time's stated time, date and zone against its
   own conversion. A wrong time or a wrong zone is struck. If the answer states no time the check can read, the model
   review may still strike it, but it cannot bill it: the call is held and not billed.
4. For tools marked for it (convert_time in the demo), a Cloudflare Workers AI model checks whether the answer
   addresses the request. A strike must quote the log word for word, or code drops it. The model never sets an amount.
5. When the tab reaches its limit, the next call returns `TAB_DUE` with a pay link. The tab becomes one PayPal order
   with line items. Access comes back the moment the capture completes.
6. A claim on a paid call is judged against the log. A duplicate claim holds only when the log has an earlier billed
   call with the same tool and request within ten minutes. That match shows a repeat. It does not prove what the buyer
   meant. If the claim holds, that call's price is refunded on the PayPal capture, within fixed limits.
7. The seller asks the desk for a chart in plain words. One model call picks the fields; code checks every field and
   writes the chart title and its scope line before AG Studio draws it. The assistant builds charts only: it cannot
   refund, approve claims or change prices.
8. Each logged call enters a hash chain (each entry holds a fingerprint of the entry before it). The fingerprint covers
   the call's number, tool, request, a digest of its answer, price, first status and time. The hosted demo signs the
   chain with a server key. **Verify ledger** recomputes it and names the first changed call. It shows that those
   recorded fields were not changed. It does not show that an answer was correct. A refund or a strike by an upheld
   claim is its own entry, so a lawful change never looks like tampering.
9. The desk keeps money scopes apart: the paid receipt, the current open tab, and this session's totals, each under
   its own heading.

## Proof

`node tests/live/attacks.live.mjs` runs 14 attacks against the hosted app, then checks 30 labelled answers in seven
groups, and writes [docs/ATTACKS.md](docs/ATTACKS.md). All 45 rows passed on 9 Nov 2026, with the real PayPal ids in
the table. Each labelled row shows whether the answer was correct and whether it was billed. The 6 good and 4 repeated
answers were billed. The 4 wrong times were struck by the time check. The 16 off topic, incomplete, injected and vague
answers were struck. No good answer was struck.
[docs/IMPACT-CASE.md](docs/IMPACT-CASE.md) puts one fixed scenario side by side: a plain meter charges $13.25 and 24 bad
answers; Running Tab charges $7.65 and 0 bad answers, for the same 37 valid calls. `npx vitest run tests/impact-case.test.ts`
reproduces it.
How each defence works is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Try the demo

Open the link, press **Run the agent**, then pay the tab with **Pay with PayPal** (sandbox buyer login below) or
**Pay by card** (PayPal's published sandbox test card, no login). Then press **Agent reports call 24** to see a
claim judged and refunded. Ask the desk for a chart, such as "struck calls by agent". Then use **Try to break it**:
write your own claim against any paid call, or pick a ready made attack, and see the verdict with the quote it used.

## For judges: pay the tab on PayPal's own page

1. Open the demo and press **Run the agent**. Wait until the tab is due.
2. Press **Pay $5.15 with PayPal** (the amount may differ). PayPal's sandbox checkout opens.
3. Log in with this sandbox test account (sandbox only, test money, never a real account):

<!-- judge-login -->
- Email: `sb-bzdbn21339224@personal.example.com`
- Password: `!_B%e5W%`
<!-- /judge-login -->

4. Approve the payment. Back on the desk, the tab shows Paid once the server has captured it, and the PayPal row turns
   confirmed when the webhook arrives.
5. Press **Agent reports call 24** to see the claim judged and refunded on the same capture.

No login at all: **Pay by card** uses PayPal's published sandbox test card instead.

## Run it

You need Node 24 or later.

```
npm install
npm --prefix desk install
npx wrangler d1 migrations apply running-tab --env local
cp .dev.vars.example .dev.vars
npm test
npm run desk:build
npx wrangler dev --env local
```

Put your PayPal sandbox app's client id and secret in `.dev.vars` (git ignores that file). The app then runs at
http://127.0.0.1:8787 with no model binding; `DEV_FAKE_AI=1` in `.dev.vars` uses a local stand in model on localhost only.

## AI used in the product

Cloudflare Workers AI, model `@cf/zai-org/glm-4.7-flash`. Every model call has a daily cap and a cap per visitor, so
a visitor never causes a paid call.

When a cap is used up, the demo keeps working and says so. A call that needed a model check is held and not billed
("Check unavailable. Call held, not billed."). A claim waits for the seller to decide. The bill note and the bill
explanation fall back to fixed text. The chart box answers "The desk's assistant has used its share for today. The
desk and the demo still work." Answers already in the cache are reused at no cost. Other daily limits per network:
10 demo workspaces, 20 PayPal orders, 10 refunds, and 5 claim tries per workspace.

## Receipts

Every figure below was read from a real response or a stored row, with its date.

| What | Number | Source |
| --- | --- | --- |
| Sandbox order, buyer approved, then captured | `POST /v2/checkout/orders/{id}/capture` 201, status COMPLETED | order 61E122899P431011R, capture 0V649728TA499130M, 22 Oct 2026 |
| Partial refund on that capture | 201 COMPLETED, refund 3GB51020HN208732K ($0.25) | same request id sent again: 200, same refund id |
| Refund larger than the capture | 422 REFUND_AMOUNT_EXCEEDED | debug_id f852394f2f384 |
| Order made by the app itself | 200 PAYER_ACTION_REQUIRED, link rel `payer-action` | order 96E39239B1237232D |
| Webhook registered | 201 | webhook 4HM98400D5812522C |
| Tab paid with the sandbox test card, on the hosted app | order 201, capture 47A60564NN304081E COMPLETED ($5.15) | debug_id f4196745f659f, 23 Oct 2026 |
| Claim on call 24 upheld by the model, then refunded | DUPLICATE; refund 65N31127JH972662A COMPLETED ($0.25) | debug_id f906076f0b9c9 |
| PayPal webhooks for that capture and refund | signature verify SUCCESS for both; tab marked paid, refund confirmed | hosted events table |
| Webhooks at the current address, running-tab.midknight-labs.workers.dev | COMPLETED for capture 7CX61156VK3945729 and REFUNDED for refund 67U10958DJ309654G, verify SUCCESS for both | hosted events table, 23 Oct 2026 |
| Neurons for one full run (audits, claim, bill note, explain_bill) | 28.06 measured on the earlier model | Workers AI's own count in each reply |
| Neurons per scripted run (audits) | 15.36 measured, 74.1 worst case charged first on the earlier model | trace rows; earlier worst case in `src/ai/budget.ts` |
| Calls struck by the model in that run | call 21, OFF_REQUEST, with the quoted answer | hosted desk |
| Full loop on the hosted app, real browser, latest code | order 6SX55078FF413820E, capture 1SP577552L003993C ($5.15), claim on call 24 refunded 4E702271X7130305X ($0.25), both webhooks verify SUCCESS | `playwright.capture.config.ts`, 23 Oct 2026; pictures in [docs/shots/e2e-hosted-happy.png](docs/shots/e2e-hosted-happy.png) |
| Bad path on the hosted app, real browser | cancelled approval keeps the tab due; forged webhook 400; a claim telling the judge to refund ten dollars denied; Verify ledger ok; another workspace's key refused | `playwright.hosted.config.ts`, 7 of 7 steps, 23 Oct 2026; [docs/shots/e2e-hosted-bad.png](docs/shots/e2e-hosted-bad.png) |
| Attack table on the hosted app | 45 of 45 rows pass: 0 false charges, 0 false strikes, 0 held (9 Nov 2026) | [docs/ATTACKS.md](docs/ATTACKS.md) |
| One fixed scenario, plain meter against Running Tab | $13.25 and 24 bad answers charged, against $7.65 and 0 | [docs/IMPACT-CASE.md](docs/IMPACT-CASE.md), `tests/impact-case.test.ts` |
| The desk's AG Studio agent on Workers AI | added a widget in 27.5 s, 4 live model rounds | `tests/live/studio-llm.live.mjs`, 23 Oct 2026 |
| Unit tests | 711 pass (570 Worker, 141 desk) on 9 Nov 2026 | `npm test`, `npm --prefix desk test` |
| Headless end to end tests (local, mock PayPal) | 14 of 14 pass (5 Nov 2026) | `npx playwright test` |

## Licence

MIT. See LICENSE.

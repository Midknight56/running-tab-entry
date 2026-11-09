# Devpost text: Running Tab

The orchestrator pastes this into Devpost. Each heading below is one Devpost field or section.

Project name: Running Tab

Elevator pitch: Billing for sellers of MCP tools. Calls that fail the seller's checks come off the bill, and PayPal settles the rest.

## Inspiration

Sellers of MCP tools charge AI agents per call. A scheduling agent may call a calendar tool hundreds of times a day. Some
of those calls fail, miss the request, or repeat the same request by mistake. A plain meter bills them all.

We wanted the seller to be able to take those charges off before the buyer pays, refund one bad call after, and show
the evidence for each decision.

## What it does

Running Tab adds billing to tools built with mcp-on-workers. Our first audience is sellers of MCP tools used by
scheduling agents, and the demo seller sells two calendar tools: business days, and time zone conversion.

Calls to wrapped tools are logged with their prices and checked by the checks the seller configures:

- Code rules strike errors, empty answers and answers with the wrong shape.
- Seller rules strike an answer that leaves out a required part, such as the date.
- A seller check can test the answer itself. The demo checks convert_time's stated time, date and zone against an
  independent conversion, and strikes a wrong time or zone. If the answer states no time the check can read, the model
  review may still strike it, but it cannot bill it: the call is held and not billed.
- Tools marked for model review (convert_time in the demo) get an AI check for whether the answer addresses the
  request. A model strike must quote the log word for word. An invalid model verdict leaves the call held and unbilled.

The promise is narrow on purpose. Running Tab strikes what these configured checks catch. It does not prove that an
answer is correct in general, and a wrong answer that no check catches is still billed.

When a tab reaches its limit, the next priced call returns `TAB_DUE` with a payment link. PayPal settles the tab as an
order with line items. Priced calls resume after capture completes.

An agent can file a claim against a billed call. An upheld claim can remove the charge before checkout and reopen a tab
that falls below its limit. For a paid call, the refund amount is that call's price, subject to fixed limits. Some
refunds wait for seller approval or confirmation from PayPal. A duplicate claim holds only when the log has an earlier
billed call with the same tool and request. That match shows a repeat; it does not prove what the buyer meant.

The seller desk keeps money scopes apart. The paid receipt reads: metered $5.50, struck before payment $0.35, captured
$5.15, refund completed $0.25, net paid $4.90. The next open tab and the session totals sit under their own headings.

The demo is a scripted demonstration with simulated faults. Call 24 is a simulated retry of call 23, not a real
timeout. "Connect an agent" gives judges an MCP endpoint and a temporary buyer key, so they can drive the tab with
their own MCP client.

## How we built it

Cloudflare Workers serves the MCP server, payment routes and seller desk. Cloudflare D1 stores the ledger. The desk uses
React, AG Studio and AG Grid.

Cloudflare Workers AI runs GLM 4.7 Flash through `@cf/zai-org/glm-4.7-flash`. It reviews convert_time answers, judges
claims, writes bill notes and helps agents ask why they were charged through `explain_bill`.

Code sets prices and refund amounts. Code also writes every money amount in bill notes and explanations. Approved model
claims must cite calls from the same bill.

The seller can ask for a chart in plain words. One model call picks the fields. Code validates them, and code writes the
chart title and a scope line that names exactly which rows are counted.

PayPal Orders v2 handles checkout and capture. The app issues partial refunds against captures and verifies webhook
signatures before applying payment events.

Order, capture and refund requests use stable request identifiers. If a response is lost, recovery keeps the original
attempt unresolved and reuses its identifier.

Logged calls enter a hash chain over selected fields: call number, tool, request, a digest of the answer, price, first
status and time. The hosted demo signs it with a server key. "Verify ledger" checks it and identifies the first changed
call. It shows that recorded fields were not changed, not that an answer was correct. Strikes and refunds have separate
chain entries.

## Challenges we ran into

Payment responses can disappear after PayPal has acted. The app must preserve that uncertainty while checking the
original attempt.

Claims can also arrive during checkout. The code coordinates charge removal with settlement so a claim cannot silently
change a bill already being paid.

Model evidence needs checks too. A copied quote supports inspection, but it does not prove that a verdict is correct.
That is why the time check is code, with expected answers written by hand in its tests.

## Accomplishments that we're proud of

The demo brings tool calls, check decisions, PayPal checkout, claims and refunds into the same seller desk.

A separate seller example covers payment, capture, verified webhooks and seller approval of refunds.

docs/IMPACT-CASE.md compares a plain meter with Running Tab on one fixed scenario, and a test reproduces every number in
it. It splits code decisions, recorded model decisions and fresh model decisions.

The live test script covers 14 attacks and an auditor evaluation of 30 labelled answers across seven groups. It scores
answer correctness on its own line, so a billed wrong answer never shows as a plain pass. On 9 Nov 2026 all 45 rows passed on the hosted app, with 0 false charges and 0 false strikes. A fixed scenario test puts a plain meter beside Running Tab: $13.25 and 24 failed or unwanted calls charged, against $7.65 and 0, for the same 37 valid calls.

## What we learned

One payment can cover many calls. Configured checks can keep some bad answers off the bill, and only those.

The model review checks relevance, not correctness. A narrow code check for the one fact that matters (the converted time) does more
than a broad model check. Clear limits and visible evidence matter when a verdict affects a charge.

## What's next

Checks for more seller tools, a second seller with its own checks, and a test of the billing flow with sellers who run
real MCP servers.

## Built with

['cloudflare-workers', 'cloudflare-d1', 'workers-ai', 'glm-4.7-flash', 'paypal', 'paypal-orders-api', 'paypal-webhooks', 'ag-studio', 'ag-grid', 'react', 'typescript', 'model-context-protocol']

## Try it out

Live demo: https://running-tab.midknight-labs.workers.dev

Repo: https://github.com/Midknight56/running-tab-entry

## Testing instructions

1. Open the hosted demo and press **Run the agent**. The demo uses the PayPal sandbox and injects faults on purpose.
2. Inspect the bill and struck calls when the tab becomes due.
3. Choose **Pay with PayPal** and use the sandbox buyer login in the README's **For judges** section. You can also
   choose **Pay by card**.
4. After payment, press **Agent reports call 24** (a simulated retry) to submit the demo claim. Inspect its verdict and
   refund status, then the paid receipt: $5.50 less $0.35 less $0.25 is $4.90 net.
5. Open **Payment details** to inspect PayPal requests and webhook records.
6. Use **Try to break it** to submit a claim, then press **Verify ledger**.
7. Try **Connect an agent**, or ask the desk for "struck calls by agent" and read the chart's scope line.

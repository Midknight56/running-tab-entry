# Impact case: one fixed scenario

This page compares a plain meter with Running Tab on one fixed scenario. It is the demo scenario only. It does not
describe customers or savings in production.

## The scenario

- The scripted demo: 30 calls by one scheduling agent. The faults are injected on purpose: an empty answer (call 9),
  an upstream error (call 14) and an off topic answer (call 21). Call 24 is a simulated retry of call 23.
- The tab is paid in the PayPal sandbox. The agent claims call 24 and gets $0.25 back. One more call goes on the next tab.
- Then 30 labelled answers from the live attack table: 6 good, 4 off topic, 4 incomplete, 4 wrong times, 4 with an
  injected instruction, 4 vague and 4 repeats of one valid request.
- 61 priced calls in all. 37 are valid. 24 are bad: the 3 demo faults, the retry on call 24, and the 20 off topic,
  incomplete, wrong, injected and vague answers.

A plain meter bills every priced call. Running Tab bills a call only when the configured checks pass it.

## Outcome

| Measure | Plain meter | Running Tab |
| --- | --- | --- |
| Charged | $13.25 | $7.65 |
| Money excluded before payment | $0.00 | $5.35 |
| Money refunded after payment | $0.00 | $0.25 |
| Valid calls charged | 37 of 37 | 37 of 37 |
| Bad answers left charged | 24 of 24 | 0 of 24 |
| Wrong times charged | 4 of 4 | 0 of 4 |
| Held calls | 0 | 0 |

## Who decided each strike

| Decided by | Calls |
| --- | --- |
| Code | 10 |
| Recorded model verdict | 13 |
| Claim | 1 |

Code: the empty answer, the upstream error, 4 incomplete answers, and 4 wrong times caught by the time check.
Recorded model verdict: the off topic demo answer, 4 off topic, 4 injected and 4 vague answers. In this test the model
gives fixed verdicts, the same ones the recorded live run gave. A fresh model call is counted only in the live run in
[docs/ATTACKS.md](ATTACKS.md).
Claim: the retry on call 24, refunded after payment.

## The demo receipt

$5.50 of metered calls less $0.35 struck is $5.15 captured. Less $0.25 refunded, the net paid is $4.90. The next open
tab is separate and is not part of this receipt.

## The newest live run

On 9 Nov 2026 the live attack table ran against the hosted app ([docs/ATTACKS.md](ATTACKS.md)). All 15 attack rows and
all 30 labelled answers passed: 0 false charges, 0 false strikes, 0 held calls. The 4 wrong times were struck by code.
The run made 3 fresh model calls. Its model audit used 0 measured neurons, so its audit verdicts came from stored
answers to the same requests.

## The earlier live run

The recorded live run before the time check (6 Nov 2026) had 4 false charges: the 4 wrong
times stayed billed. It had 0 false strikes and 0 held calls. The convert_time time check was added after that run. With the
time check switched off, this test also charges the 4 wrong times.

## Limits

- One demo seller, two calendar tools and scripted faults.
- The time check covers convert_time only.
- The model review checks that an answer fits the request. It does not check that the answer is right.
- A wrong answer that no check catches is still billed.

## Reproduce

```bash
npx vitest run tests/impact-case.test.ts
```

The test runs the whole scenario through the Worker with a fake database, a fake PayPal and fixed model verdicts. It
compares its numbers with a fixed object written by hand, and checks that this page shows the same numbers.

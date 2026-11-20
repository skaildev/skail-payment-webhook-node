# skail payment webhook (Node.js)

[Português (Brasil)](README.pt-BR.md)

A console app with a skail function that releases an order when the payment gateway says the payment came in. Gateways send the same webhook two or three times, so the run id is derived from the event id: the resends land on the same run, and the order is released once. When the payment does not match the invoice, finance gets a review and the order stays put.

It shows three skail features:

- a **run id derived from the business id**: a UUID v5 of the event id, so a resent webhook does not start a second run;
- **idempotent commands**: every write uses the event id as its key, so a retried command does not do it twice;
- **results instead of errors**: a payment that does not match comes back as a result and goes to finance, because another attempt would not change it.

## Requirements

- One of: [Docker](https://docs.docker.com/get-docker/), [Podman](https://podman.io/docs/installation) or [Node.js](https://nodejs.org) 20.12 or newer. The run script uses the first one it finds.
- A skail environment with a workload registered for the `SKAIL_WORKLOAD` in `.env` (`demopaymentwebhook:v1.0.0` by default). The [Quickstart](https://docs.skail.dev/comece-aqui/quickstart) shows how to create the account, the environment and the workload.

The project uses `@skail/runtime` and `@skail/build` **2.0.1-rc4**.

## Run

```bash
cp .env.example .env     # fill in SKAIL_SIDECAR, SKAIL_NAMESPACE and SKAIL_KEY (portal > Environments & keys > Connect)
scripts/run.sh           # one payment per path
scripts/run.sh released  # or amount, paid, missing: only that payment
```

On Windows, in PowerShell: `copy .env.example .env`, then `powershell -ExecutionPolicy Bypass -File scripts\run.ps1` with the same arguments. The script works on the Windows PowerShell built into Windows; PowerShell 7 is not needed.

The script runs the demo with what the machine has: Docker, then Podman, then Node.js. If it finds none of them, it says what to install. Without the script, the commands are `npm install`, `npm run build` and `npm start` (with the arguments after `--`, as in `npm start -- <argument>`).

```text
[evt_5533bee0] webhook: order P-1, R$ 99.90 → run 4b1d3879 (expected: released once, however many times it is sent)
[evt_5533bee0] invoice P-1: paid, R$ 99.90
[evt_5533bee0] delivery: order P-1 released
[evt_5533bee0] result: released for delivery
[evt_5533bee0] webhook resent (2×) → run 4b1d3879, the same run
[evt_5533bee0] webhook resent (3×) → run 4b1d3879, the same run
[evt_f248f888] webhook: order P-2, R$ 200.00 → run e8e58477 (expected: finance review: the amount does not match)
[evt_afab5d35] webhook: order P-3, R$ 80.00 → run 7589fe60 (expected: finance review: the invoice was already paid)
[evt_509c3ea2] webhook: order P-9, R$ 10.00 → run b9dab20d (expected: finance review: there is no invoice)
Press Ctrl+C to exit.
[evt_f248f888] finance: review opened for order P-2 (paid R$ 200.00, invoice R$ 250.00)
[evt_f248f888] result: pending: paid R$ 200.00, invoice R$ 250.00
[evt_afab5d35] finance: review opened for order P-3 (the invoice was already paid by another payment)
[evt_afab5d35] result: pending: the invoice was already paid by another payment
[evt_509c3ea2] finance: review opened for order P-9 (no invoice for order P-9)
[evt_509c3ea2] result: pending: no invoice for order P-9
```

The first payment is sent three times, two seconds apart, like a gateway that did not get the answer in time. All three land on the same run, and the order is released once.

## The paths

The demo store has three invoices: **P-1** R$ 99.90 (open), **P-2** R$ 250.00 (open) and **P-3** R$ 80.00 (already paid by an older event).

| Path | Payment | What happens | Result |
|---|---|---|---|
| `released` | P-1, R$ 99.90, sent 3 times | the invoice is paid and the order is released, once | `released for delivery` |
| `amount` | P-2, R$ 200.00 | the amount does not match the invoice; finance gets a review | `pending: paid R$ 200.00, invoice R$ 250.00` |
| `paid` | P-3, R$ 80.00 | the invoice was already paid by another payment | `pending: the invoice was already paid by another payment` |
| `missing` | P-9, R$ 10.00 | there is no invoice for the order | `pending: no invoice for order P-9` |

## How it works

The app does three jobs in one process: it keeps the demo store (invoices, deliveries and finance reviews, which print each change), it plays the payment gateway and the webhook endpoint, starting one run per event through the skail HTTP API, and it hosts the worker that runs the function (`createSkailPlatform`, with the bundle built by `npm run build`). The commands run in an isolated VM, so they reach the demo store over HTTP on a local port, as they would reach a real database API.

The run id is a UUID v5 of the event id, with a fixed namespace of the application ([`src/run-ids.ts`](src/run-ids.ts)). The same event always gives the same run id, and skail does not start a second run for an id it already has:

```http
POST {SKAIL_SIDECAR}/api/v1/trigger/demopaymentwebhook/v1.0.0/ReleaseOrder/{UUID v5 of the event id}
[{"eventId": "evt_5533bee0", "orderId": "P-1", "amount": 99.9}]
```

The function, in [`src/payment-functions.ts`](src/payment-functions.ts):

```ts
@SkailFunction()
async ReleaseOrder(payment: PaymentConfirmed): Promise<string> {
  const settlement = await this.SettleInvoice(payment);
  if (!settlement.done) {
    // the money came in, but something does not match: finance reviews it before the order leaves
    await this.OpenFinanceReview(payment, settlement.reason!);
    return this.ReportResult(payment.eventId, PaymentResults.pending(settlement.reason!));
  }

  await this.ReleaseForDelivery(payment.orderId, payment.eventId);
  return this.ReportResult(payment.eventId, PaymentResults.released);
}
```

- `SettleInvoice` checks the invoice and records the payment against it. A mismatch comes back as a result (`done = false`), not an exception.
- `ReleaseForDelivery` only runs with the invoice settled, and `OpenFinanceReview` takes its place on a mismatch.
- Every write uses the event id as its key. If the app stops in the middle of a command, skail runs it again, and the store does not apply it twice.

| File | What it has |
|---|---|
| `src/payment-functions.ts` | The function and its commands. |
| `src/run-ids.ts` | The run id from the event id (UUID v5). |
| `src/simulated-store.ts` | The demo store (invoices, deliveries and finance reviews), served over local HTTP. |
| `src/main.ts` | Reads `.env` and the argument, starts the store and the worker, and plays the gateway: sends each payment and resends the first one. |
| `src/demo-payments.ts` | The payment of each path. |
| `src/skail-api.ts` | The trigger through the skail HTTP API. |
| `scripts/build-skail.mjs` | Builds the bundle into `.skail/` for `SKAIL_WORKLOAD`; run `npm run build` again if it changes. |
| `scripts/run.sh`, `scripts/run.ps1`, `Dockerfile` | Run the demo with Docker, Podman or Node.js, whatever the machine has. |

In the portal, open the [Monitor](https://docs.skail.dev/referencia/portal/monitor) of your environment: there is one `ReleaseOrder` run per event, however many times it was sent. It lists `SettleInvoice`, `ReleaseForDelivery` and `ReportResult`; on a mismatch, `OpenFinanceReview` takes the place of `ReleaseForDelivery`. Every path ends as **Completed**, because a mismatch is a result.

## Notes

- Each run of the app uses new event ids, so it does not land on the runs of the previous one. The demo store lives in memory and starts over each time.
- Apps running the same `SKAIL_WORKLOAD` on the same environment share the same runs: use one workload (or environment) per person.

## Disclaimer

**This is a demo, not production code.** It exists only to show how [skail](https://docs.skail.dev) works and is provided "as is", without warranty of any kind. The payment gateway and the store are simulated: no real payment is made or checked.

## License

[Apache-2.0](LICENSE)

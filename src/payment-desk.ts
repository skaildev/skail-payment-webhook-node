import { randomUUID } from "node:crypto";
import { demoPayments } from "./demo-payments.js";
import type { PaymentConfirmed } from "./model.js";
import { runIdFromEventId } from "./run-ids.js";
import { money, type SimulatedStore } from "./simulated-store.js";
import type { SkailApiClient } from "./skail-api.js";
import type { Timeline } from "./timeline.js";

interface Webhook {
  payment: PaymentConfirmed;
  runId: string;
  deliveries: number;
}

/**
 * Plays the payment gateway and the webhook endpoint for the page, one scenario per card: each delivery of an event
 * starts ReleaseOrder with the run id derived from the event id. Resending the event of a card uses the same event id,
 * so skail does not start a second run.
 */
export class PaymentDesk {
  private readonly sent = new Map<string, Webhook>(); // by scenario

  constructor(
    private readonly store: SimulatedStore,
    private readonly skail: SkailApiClient,
    private readonly timeline: Timeline,
  ) {}

  /** Sends the payment of a scenario, once: a new event id, so it does not land on a previous run. */
  async send(path: string): Promise<boolean> {
    const demo = demoPayments.find((p) => p.path === path);
    if (!demo || this.sent.has(path)) return false;

    const payment = { eventId: `evt_${randomUUID().slice(0, 8)}`, orderId: demo.orderId, amount: demo.amount };
    const webhook = { payment, runId: runIdFromEventId(payment.eventId), deliveries: 0 };
    this.sent.set(path, webhook);
    await this.deliver(webhook);
    return true;
  }

  /** The gateway sends the event of the scenario again, with the same event id: it lands on the same run. */
  async sendAgain(path: string): Promise<boolean> {
    const webhook = this.sent.get(path);
    if (!webhook) return false;
    await this.deliver(webhook);
    return true;
  }

  /** Back to the start: the invoices as they were, and no payment sent. */
  reset(): void {
    this.sent.clear();
    this.store.reset();
    this.timeline.clear();
  }

  private async deliver(webhook: Webhook): Promise<void> {
    await this.skail.trigger(webhook.runId, webhook.payment);
    const { eventId, orderId, amount } = webhook.payment;
    const run = webhook.runId.slice(0, 8);
    this.timeline.add(
      eventId,
      ++webhook.deliveries === 1
        ? `webhook: order ${orderId}, ${money(amount)} → run ${run}`
        : `webhook resent (${webhook.deliveries}×) → run ${run}, the same run`,
    );
  }

  /** What the page shows: each scenario with its invoice and, once sent, what happened to its event. */
  view() {
    const entries = this.timeline.all();
    const count = (eventId: string, step: string) =>
      entries.filter((e) => e.runId === eventId && e.step === step).length;

    return {
      scenarios: demoPayments.map((d) => {
        const webhook = this.sent.get(d.path);
        const eventId = webhook?.payment.eventId ?? "";
        return {
          path: d.path,
          orderId: d.orderId,
          amount: d.amount,
          invoice: this.store.invoiceOf(d.orderId),
          sent: webhook && {
            eventId,
            runId: webhook.runId,
            deliveries: webhook.deliveries,
            released: count(eventId, "released"),
            reviews: count(eventId, "review"),
            result: [...entries]
              .reverse()
              .find((t) => t.runId === eventId && t.step?.startsWith("end:"))
              ?.step?.slice(4),
          },
        };
      }),
      timeline: entries.map((t) => ({ at: t.at, event: t.runId, text: t.text })),
    };
  }
}

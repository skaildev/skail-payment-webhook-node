import { SkailCommand, SkailFunction } from "@skail/runtime";
import { PaymentResults, type PaymentConfirmed, type SettleResult } from "./model.js";

// Method names are PascalCase on purpose: the skail address is <workload>/<method>, and the trigger calls
// <workload>/ReleaseOrder.
export class PaymentFunctions {
  /**
   * The gateway says a payment came in, sometimes two or three times. The run id comes from the event id, so the
   * resends land on this same run. The order only leaves when the invoice is settled; when something does not match,
   * finance reviews the payment and the order stays put.
   * The name and the parameter are the trigger contract: [{"eventId", "orderId", "amount"}].
   */
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

  // The commands are the I/O, one operation each. skail never runs a completed command again, but a retry runs the
  // whole command again, so every write uses the event id as its idempotency key.

  /** Settles the invoice of the order. Not matching is a result (done = false), not an error. */
  @SkailCommand({ retryCount: 3 })
  async SettleInvoice(payment: PaymentConfirmed): Promise<SettleResult> {
    return callStore("invoices/settle", payment);
  }

  @SkailCommand({ retryCount: 3 })
  async OpenFinanceReview(payment: PaymentConfirmed, reason: string): Promise<void> {
    await callStore("reviews/open", { eventId: payment.eventId, orderId: payment.orderId, reason });
  }

  @SkailCommand({ retryCount: 3 })
  async ReleaseForDelivery(orderId: string, eventId: string): Promise<void> {
    await callStore("deliveries/release", { orderId, eventId });
  }

  /** Prints how the payment ended and returns that result to the function. */
  @SkailCommand()
  async ReportResult(eventId: string, result: string): Promise<string> {
    console.log(`[${eventId}] result: ${result}`);
    return result;
  }
}

/**
 * Calls the demo store, which runs in the main process of this app (src/simulated-store.ts): commands run in an
 * isolated VM, so they reach it over HTTP, like they would reach a real database API.
 */
async function callStore<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${process.env.DEMO_STORE_URL}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const content = await response.text();
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${content}`);
  return (content ? JSON.parse(content) : undefined) as T;
}

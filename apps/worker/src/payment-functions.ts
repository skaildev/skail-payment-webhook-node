import { SkailCommand, SkailFunction, SkailNonDeterministicError } from "@skail/runtime";
import {
  PaymentResults,
  type EventStage,
  type SettleResult,
  type PaymentConfirmed,
} from "@skail-payment-webhook/contracts";
import { InvoiceSettler } from "./invoice-settler.js";
import type { InvoiceStore, StatusNotifier } from "./web.js";

// Method names are PascalCase because the skail URI is <workload>/<method>: the web app triggers <workload>/ReleaseOrder,
// and the Monitor lists each step by its method name.
export class PaymentFunctions {
  readonly #settler: InvoiceSettler;

  constructor(
    private readonly store: InvoiceStore,
    private readonly notifier: StatusNotifier,
  ) {
    this.#settler = new InvoiceSettler(store);
  }

  /**
   * The gateway says a payment came in, sometimes two or three times. The event id is the execution id, so the resends
   * land on this same execution. The order only leaves when the invoice is settled; when something does not match,
   * finance reviews the payment first and the order stays put.
   */
  @SkailFunction()
  async ReleaseOrder(payment: PaymentConfirmed): Promise<string> {
    await this.ReportStatus(payment.eventId, "Started", null);

    let result: string;
    try {
      const settlement = await this.SettleInvoice(payment);
      if (!settlement.done) {
        // The money came in, but something does not match: finance reviews it before the order leaves.
        await this.OpenFinanceReview(payment, settlement.reason!);
        result = PaymentResults.pending(settlement.reason!);
      } else {
        await this.ReleaseForDelivery(payment.orderId, payment.eventId); // only runs with the invoice settled
        result = PaymentResults.released;
      }
    } catch (error) {
      if (error instanceof SkailNonDeterministicError) throw error; // the code and the run history diverged
      // Every attempt of a command failed (a technical error, not a mismatch): say so on the page and rethrow, so the
      // run shows up as failed in the Monitor.
      await this.ReportStatus(payment.eventId, "Failed", error instanceof Error ? error.message : String(error));
      throw error;
    }

    await this.ReportStatus(payment.eventId, "Completed", result);
    return result;
  }

  /** Settles the invoice. A mismatch comes back as a result (`done: false`), not as an error: nothing to retry. */
  @SkailCommand({ retryCount: 3 })
  async SettleInvoice(payment: PaymentConfirmed): Promise<SettleResult> {
    return this.#settler.settle(payment);
  }

  /** Idempotent by event id. */
  @SkailCommand({ retryCount: 3 })
  async OpenFinanceReview(payment: PaymentConfirmed, reason: string): Promise<void> {
    await this.store.addReview({ eventId: payment.eventId, orderId: payment.orderId, reason });
  }

  /** Idempotent by event id: a retried command does not release the order twice. */
  @SkailCommand({ retryCount: 3 })
  async ReleaseForDelivery(orderId: string, eventId: string): Promise<void> {
    await this.store.release(orderId, eventId);
  }

  /** Tells the page how the run is going. Idempotent: the web app ignores a repeated status. */
  @SkailCommand({ retryCount: 3 })
  async ReportStatus(eventId: string, stage: EventStage, detail: string | null): Promise<void> {
    await this.notifier.notify({ eventId, stage, detail });
  }
}

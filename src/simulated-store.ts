import type { SettleResult } from "./model.js";
import type { Timeline } from "./timeline.js";

export const alreadyPaidByAnother = "the invoice was already paid by another payment";

/**
 * The demo "database": the invoices, the deliveries and the finance reviews. In your system these would be your tables;
 * here they live in memory and report each change to the timeline (console and page). Every write is idempotent by
 * event id, because a retried command runs again.
 */
export class SimulatedStore {
  constructor(private readonly timeline: Timeline) {}

  /** The invoices by order id, and the event that paid each one. */
  private invoices = openInvoices();
  private readonly released = new Set<string>(); // order ids
  private readonly reviews = new Set<string>(); // event ids

  /** May this payment settle the invoice? Everything that does not match comes back as a result. */
  settle(eventId: string, orderId: string, amount: number): SettleResult {
    const invoice = this.invoices.get(orderId);
    if (!invoice) return { done: false, reason: `no invoice for order ${orderId}` };
    if (invoice.paidByEvent === eventId) return { done: true, reason: null }; // a retry of this same settlement
    if (invoice.paidByEvent !== null) return { done: false, reason: alreadyPaidByAnother };
    if (invoice.amount !== amount)
      return { done: false, reason: `paid ${money(amount)}, invoice ${money(invoice.amount)}` };

    invoice.paidByEvent = eventId;
    this.timeline.add(eventId, `invoice ${orderId}: paid, ${money(amount)}`);
    return { done: true, reason: null };
  }

  release(orderId: string, eventId: string): void {
    if (this.released.has(orderId)) return;
    this.released.add(orderId);
    this.timeline.add(eventId, `delivery: order ${orderId} released`, "released");
  }

  openReview(eventId: string, orderId: string, reason: string): void {
    if (this.reviews.has(eventId)) return;
    this.reviews.add(eventId);
    this.timeline.add(eventId, `finance: review opened for order ${orderId} (${reason})`, "review");
  }

  /** The store calls the commands make over HTTP, by route (the app serves them under /internal/store/). */
  call(route: string, body: any): unknown {
    switch (route) {
      case "invoices/settle":
        return this.settle(body.eventId, body.orderId, body.amount);
      case "deliveries/release":
        return this.release(body.orderId, body.eventId);
      case "reviews/open":
        return this.openReview(body.eventId, body.orderId, body.reason);
      default:
        throw new Error(`Unknown store route ${route}`);
    }
  }

  /** The invoice of the order, for the page: its amount and the event that paid it, if any. */
  invoiceOf(orderId: string) {
    const invoice = this.invoices.get(orderId);
    return invoice ? { amount: invoice.amount, paidBy: invoice.paidByEvent } : null;
  }

  /** Back to the invoices of the start, with nothing released nor reviewed (the Start over button). */
  reset(): void {
    this.invoices = openInvoices();
    this.released.clear();
    this.reviews.clear();
  }
}

/** The invoices of the store, by order id. P-3 was already paid by an older event. */
function openInvoices() {
  return new Map<string, { amount: number; paidByEvent: string | null }>([
    ["P-1", { amount: 99.9, paidByEvent: null }],
    ["P-2", { amount: 250, paidByEvent: null }],
    ["P-3", { amount: 80, paidByEvent: "evt_old" }],
  ]);
}

export function money(value: number): string {
  return `R$ ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

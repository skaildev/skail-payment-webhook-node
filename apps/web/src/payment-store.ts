import {
  isTerminal,
  stateOfResult,
  type EventState,
  type EventStatus,
  type Invoice,
  type PaymentConfirmed,
  type ReviewRequest,
  type ReviewView,
  type StateView,
} from "@skail-payment-webhook/contracts";

export type MarkPaidResult = "ok" | "notFound" | "paidByAnother";

interface EventRow {
  payment: PaymentConfirmed;
  taskId: string;
  deliveries: number;
  accepted: boolean;
  state: EventState;
  result: string | null;
}

/** P-1 and P-2 are open; P-3 was already paid by another event. */
function seed(): Map<string, Invoice> {
  return new Map<string, Invoice>([
    ["P-1", { orderId: "P-1", amount: 99.9, paidByEvent: null }],
    ["P-2", { orderId: "P-2", amount: 250, paidByEvent: null }],
    ["P-3", { orderId: "P-3", amount: 80, paidByEvent: "evt_old" }],
  ]);
}

/**
 * In-memory "database" of the demo (invoices, deliveries, finance reviews) and the view of the received webhooks.
 * The durable state lives in skail; this is what the page shows. Every write that comes from the worker is idempotent
 * by event id, because a command that is retried runs again.
 */
export class PaymentStore {
  #invoices = seed();
  #releases = new Map<string, Set<string>>();
  #events: EventRow[] = [];
  #reviews = new Map<string, ReviewView>();
  readonly #subscribers = new Set<(state: StateView) => void>();

  // --- the webhook ---------------------------------------------------------------------------------------------

  /** A webhook delivery arrived: new event, or one more delivery of an event already known. */
  recordDelivery(payment: PaymentConfirmed, taskId: string): void {
    let row = this.#find(payment.eventId);
    if (!row) {
      row = { payment, taskId, deliveries: 0, accepted: false, state: "Received", result: null };
      this.#events.push(row);
    }
    row.deliveries++;
    this.#publish();
  }

  /** skail accepted the trigger. */
  markAccepted(eventId: string): void {
    const row = this.#find(eventId);
    if (!row) return;
    row.accepted = true;
    if (row.state === "NotAccepted") row.state = "Received";
    this.#publish();
  }

  /** skail did not accept the trigger (the gateway will resend). */
  markNotAccepted(eventId: string): void {
    const row = this.#find(eventId);
    if (!row || row.accepted || row.state !== "Received") return;
    row.state = "NotAccepted";
    this.#publish();
  }

  // --- the demo "database" (called by the worker) --------------------------------------------------------------

  getInvoice(orderId: string): Invoice | undefined {
    return this.#invoices.get(orderId);
  }

  /** Marks the invoice paid by the event: idempotent for the same event, refused when another event paid it. */
  markPaid(orderId: string, eventId: string): MarkPaidResult {
    const invoice = this.#invoices.get(orderId);
    if (!invoice) return "notFound";
    if (invoice.paidByEvent !== null && invoice.paidByEvent !== eventId) return "paidByAnother";
    if (invoice.paidByEvent === null) {
      this.#invoices.set(orderId, { ...invoice, paidByEvent: eventId });
      this.#publish();
    }
    return "ok";
  }

  /** Idempotent by event id: a retried command does not release the order twice. */
  release(orderId: string, eventId: string): void {
    let events = this.#releases.get(orderId);
    if (!events) this.#releases.set(orderId, (events = new Set()));
    if (!events.has(eventId)) {
      events.add(eventId);
      this.#publish();
    }
  }

  /** Idempotent by event id. */
  addReview(review: ReviewRequest): void {
    if (this.#reviews.has(review.eventId)) return;
    this.#reviews.set(review.eventId, { ...review });
    this.#publish();
  }

  // --- progress of the execution (called by the worker) --------------------------------------------------------

  /** @returns true when the status moved the event; false when ignored (unknown or finished event). */
  applyStatus(status: EventStatus): boolean {
    const row = this.#find(status.eventId);
    if (!row || isTerminal(row.state)) return false;

    switch (status.stage) {
      case "Started":
        row.state = "Running";
        break;
      case "Completed":
        row.state = stateOfResult(status.detail);
        row.result = status.detail ?? null;
        break;
      case "Failed":
        row.state = "Failed";
        row.result = status.detail ?? null;
        break;
    }
    this.#publish();
    return true;
  }

  // --- the page ------------------------------------------------------------------------------------------------

  snapshot(): StateView {
    return {
      invoices: [...this.#invoices.values()]
        .sort((a, b) => a.orderId.localeCompare(b.orderId))
        .map((i) => ({ ...i, releases: this.#releases.get(i.orderId)?.size ?? 0 })),
      events: this.#events.map((e) => ({
        eventId: e.payment.eventId,
        orderId: e.payment.orderId,
        amount: e.payment.amount,
        taskId: e.taskId,
        deliveries: e.deliveries,
        state: e.state,
        result: e.result,
      })),
      reviews: [...this.#reviews.values()],
    };
  }

  /** Back to the seed: open invoices, no events, no reviews. For running the demo again. */
  reset(): void {
    this.#invoices = seed();
    this.#releases = new Map();
    this.#events = [];
    this.#reviews = new Map();
    this.#publish();
  }

  /** @returns the unsubscribe function. The listener gets a full snapshot on every change. */
  subscribe(listener: (state: StateView) => void): () => void {
    this.#subscribers.add(listener);
    return () => void this.#subscribers.delete(listener);
  }

  #find(eventId: string): EventRow | undefined {
    return this.#events.find((e) => e.payment.eventId === eventId);
  }

  #publish(): void {
    if (this.#subscribers.size === 0) return;
    const state = this.snapshot();
    for (const listener of [...this.#subscribers]) listener(state);
  }
}

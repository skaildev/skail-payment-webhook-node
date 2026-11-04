import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentConfirmed, StateView } from "@skail-payment-webhook/contracts";
import { PaymentStore } from "../src/payment-store.js";

const payment: PaymentConfirmed = { eventId: "evt_1", orderId: "P-1", amount: 99.9 };

let store: PaymentStore;
beforeEach(() => {
  store = new PaymentStore();
});

const event = (eventId = "evt_1") => store.snapshot().events.find((e) => e.eventId === eventId);

describe("PaymentStore: the webhook", () => {
  it("starts with the seeded invoices: P-1 and P-2 open, P-3 already paid", () => {
    expect(store.snapshot().invoices).toEqual([
      { orderId: "P-1", amount: 99.9, paidByEvent: null, releases: 0 },
      { orderId: "P-2", amount: 250, paidByEvent: null, releases: 0 },
      { orderId: "P-3", amount: 80, paidByEvent: "evt_old", releases: 0 },
    ]);
  });

  it("counts the deliveries of the same event on one row with the same execution id", () => {
    store.recordDelivery(payment, "task-1");
    store.recordDelivery(payment, "task-1");
    store.recordDelivery(payment, "task-1");

    expect(store.snapshot().events).toHaveLength(1);
    expect(event()).toMatchObject({ deliveries: 3, taskId: "task-1", state: "Received" });
  });

  it("shows NotAccepted when skail refused, and Received again once a resend is accepted", () => {
    store.recordDelivery(payment, "task-1");
    store.markNotAccepted("evt_1");
    expect(event()!.state).toBe("NotAccepted");

    store.recordDelivery(payment, "task-1");
    store.markAccepted("evt_1");
    expect(event()).toMatchObject({ state: "Received", deliveries: 2 });
  });

  it("does not mark NotAccepted an event skail already accepted", () => {
    store.recordDelivery(payment, "task-1");
    store.markAccepted("evt_1");
    store.markNotAccepted("evt_1");
    expect(event()!.state).toBe("Received");
  });
});

describe("PaymentStore: the demo database", () => {
  it("marks the invoice paid, idempotently for the same event", () => {
    expect(store.markPaid("P-1", "evt_1")).toBe("ok");
    expect(store.markPaid("P-1", "evt_1")).toBe("ok");
    expect(store.getInvoice("P-1")!.paidByEvent).toBe("evt_1");
  });

  it("refuses when another event paid the invoice, and when there is no invoice", () => {
    expect(store.markPaid("P-3", "evt_1")).toBe("paidByAnother");
    expect(store.markPaid("P-9", "evt_1")).toBe("notFound");
  });

  it("releases the order once per event, however many times the command runs", () => {
    store.release("P-1", "evt_1");
    store.release("P-1", "evt_1");
    expect(store.snapshot().invoices[0]!.releases).toBe(1);
  });

  it("keeps one review per event", () => {
    store.addReview({ eventId: "evt_1", orderId: "P-1", reason: "x" });
    store.addReview({ eventId: "evt_1", orderId: "P-1", reason: "x" });
    expect(store.snapshot().reviews).toEqual([{ eventId: "evt_1", orderId: "P-1", reason: "x" }]);
  });
});

describe("PaymentStore: progress", () => {
  beforeEach(() => store.recordDelivery(payment, "task-1"));

  it("follows Started and then Released", () => {
    store.applyStatus({ eventId: "evt_1", stage: "Started" });
    expect(event()!.state).toBe("Running");

    store.applyStatus({ eventId: "evt_1", stage: "Completed", detail: "released for delivery" });
    expect(event()).toMatchObject({ state: "Released", result: "released for delivery" });
  });

  it("ends Pending when the result starts with 'pending: '", () => {
    store.applyStatus({ eventId: "evt_1", stage: "Completed", detail: "pending: no invoice for order P-1" });
    expect(event()!.state).toBe("Pending");
  });

  it("ends Failed with the message", () => {
    store.applyStatus({ eventId: "evt_1", stage: "Failed", detail: "web down" });
    expect(event()).toMatchObject({ state: "Failed", result: "web down" });
  });

  it("ignores a status of a finished event and of an unknown event", () => {
    store.applyStatus({ eventId: "evt_1", stage: "Completed", detail: "released for delivery" });
    expect(store.applyStatus({ eventId: "evt_1", stage: "Started" })).toBe(false);
    expect(store.applyStatus({ eventId: "nope", stage: "Started" })).toBe(false);
    expect(event()!.state).toBe("Released");
  });
});

describe("PaymentStore: reset and subscribers", () => {
  it("goes back to the seed", () => {
    store.recordDelivery(payment, "task-1");
    store.markPaid("P-1", "evt_1");
    store.release("P-1", "evt_1");
    store.addReview({ eventId: "evt_1", orderId: "P-1", reason: "x" });

    store.reset();

    const state = store.snapshot();
    expect(state.events).toEqual([]);
    expect(state.reviews).toEqual([]);
    expect(state.invoices.map((i) => [i.orderId, i.paidByEvent, i.releases])).toEqual([
      ["P-1", null, 0],
      ["P-2", null, 0],
      ["P-3", "evt_old", 0],
    ]);
  });

  it("sends a snapshot to the subscribers on every change, until they unsubscribe", () => {
    const seen: StateView[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s));

    store.recordDelivery(payment, "task-1");
    store.markPaid("P-1", "evt_1");
    unsubscribe();
    store.release("P-1", "evt_1");

    expect(seen).toHaveLength(2);
    expect(seen[1]!.invoices[0]!.paidByEvent).toBe("evt_1");
  });
});

import { describe, expect, it } from "vitest";
import type { Invoice, PaymentConfirmed, ReviewRequest } from "@skail-payment-webhook/contracts";
import { InvoiceSettler } from "../src/invoice-settler.js";
import type { InvoiceStore } from "../src/web.js";

class FakeStore implements InvoiceStore {
  readonly paid: [string, string][] = [];
  readonly released: [string, string][] = [];
  readonly reviews: ReviewRequest[] = [];
  refuseMarkPaid = false;

  constructor(private readonly invoice: Invoice | null) {}

  async get() {
    return this.invoice;
  }
  async markPaid(orderId: string, eventId: string) {
    this.paid.push([orderId, eventId]);
    return !this.refuseMarkPaid;
  }
  async release(orderId: string, eventId: string) {
    this.released.push([orderId, eventId]);
  }
  async addReview(review: ReviewRequest) {
    this.reviews.push(review);
  }
}

const payment = (patch: Partial<PaymentConfirmed> = {}): PaymentConfirmed => ({
  eventId: "evt_1",
  orderId: "P-1",
  amount: 99.9,
  ...patch,
});
const open: Invoice = { orderId: "P-1", amount: 99.9, paidByEvent: null };

describe("InvoiceSettler", () => {
  it("settles an open invoice when the amount matches", async () => {
    const store = new FakeStore(open);
    expect(await new InvoiceSettler(store).settle(payment())).toEqual({ done: true, reason: null });
    expect(store.paid).toEqual([["P-1", "evt_1"]]);
  });

  it("settles again for the same event (a retry of the command)", async () => {
    const store = new FakeStore({ ...open, paidByEvent: "evt_1" });
    expect(await new InvoiceSettler(store).settle(payment())).toEqual({ done: true, reason: null });
    expect(store.paid).toEqual([["P-1", "evt_1"]]);
  });

  it("returns a result, not an error, when the amount differs", async () => {
    const store = new FakeStore({ ...open, amount: 250 });
    expect(await new InvoiceSettler(store).settle(payment({ amount: 200 }))).toEqual({
      done: false,
      reason: "paid R$ 200.00, invoice R$ 250.00",
    });
    expect(store.paid).toEqual([]);
  });

  it("returns a result when there is no invoice", async () => {
    const store = new FakeStore(null);
    expect(await new InvoiceSettler(store).settle(payment({ orderId: "P-9" }))).toEqual({
      done: false,
      reason: "no invoice for order P-9",
    });
  });

  it("returns a result when another payment already paid the invoice", async () => {
    const store = new FakeStore({ ...open, paidByEvent: "evt_old" });
    const result = await new InvoiceSettler(store).settle(payment());
    expect(result.done).toBe(false);
    expect(result.reason).toMatch(/already paid/);
    expect(store.paid).toEqual([]);
  });

  it("returns a result when the store refuses the write because another event got there first", async () => {
    const store = new FakeStore(open);
    store.refuseMarkPaid = true;
    const result = await new InvoiceSettler(store).settle(payment());
    expect(result.done).toBe(false);
    expect(result.reason).toMatch(/already paid/);
  });

  it("compares the amounts in cents", async () => {
    const store = new FakeStore({ ...open, amount: 0.3 });
    expect((await new InvoiceSettler(store).settle(payment({ amount: 0.1 + 0.2 }))).done).toBe(true);
  });
});

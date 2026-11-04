import { beforeEach, describe, expect, it } from "vitest";
import { EventType, type Provider } from "@skail/runtime";
import { createSkailWorker, type SkailWorker } from "@skail/runtime/testing";
import { InMemorySkailPlatform } from "@skail/testing";
import type { EventStatus, Invoice, PaymentConfirmed, ReviewRequest } from "@skail-payment-webhook/contracts";
import { PaymentFunctions } from "../src/payment-functions.js";
import type { InvoiceStore, StatusNotifier } from "../src/web.js";

const WORKLOAD = "payment-webhook:v0.0.1";
const URI = `${WORKLOAD}/ReleaseOrder`;

class Harness {
  readonly invoices = new Map<string, Invoice>([["P-1", { orderId: "P-1", amount: 99.9, paidByEvent: null }]]);
  readonly released: [string, string][] = [];
  readonly reviews: ReviewRequest[] = [];
  readonly statuses: EventStatus[] = [];
  failReads = 0; // transient failures of the invoice read before succeeding
  alwaysFail = false;
  readonly platform = new InMemorySkailPlatform();
  readonly worker: SkailWorker;

  constructor() {
    const store: InvoiceStore = {
      get: async (orderId) => {
        if (this.alwaysFail) throw new Error("web down");
        if (this.failReads > 0) {
          this.failReads--;
          throw new Error("transient");
        }
        return this.invoices.get(orderId) ?? null;
      },
      markPaid: async (orderId, eventId) => {
        const invoice = this.invoices.get(orderId)!;
        if (invoice.paidByEvent && invoice.paidByEvent !== eventId) return false;
        this.invoices.set(orderId, { ...invoice, paidByEvent: eventId });
        return true;
      },
      release: async (orderId, eventId) => {
        if (!this.released.some(([o, e]) => o === orderId && e === eventId)) this.released.push([orderId, eventId]);
      },
      addReview: async (review) => void this.reviews.push(review),
    };
    const notifier: StatusNotifier = { notify: async (status) => void this.statuses.push(status) };
    const providers: Provider[] = [
      { token: PaymentFunctions, useFactory: () => new PaymentFunctions(store, notifier) },
    ];
    this.worker = createSkailWorker({
      workload: WORKLOAD,
      types: [PaymentFunctions],
      providers,
      sidecar: this.platform,
    });
  }

  start(payment: PaymentConfirmed) {
    this.platform.start(URI, [payment], payment.eventId);
  }

  async run() {
    return this.worker.runActivation((await this.platform.consume())!);
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

const payment = (patch: Partial<PaymentConfirmed> = {}): PaymentConfirmed => ({
  eventId: "evt_1",
  orderId: "P-1",
  amount: 99.9,
  ...patch,
});

describe("ReleaseOrder", () => {
  it("settles the invoice, releases the order once and completes", async () => {
    h.start(payment());
    expect(await h.run()).toEqual({ status: "completed", result: "released for delivery" });

    expect(h.invoices.get("P-1")!.paidByEvent).toBe("evt_1");
    expect(h.released).toEqual([["P-1", "evt_1"]]);
    expect(h.reviews).toEqual([]);
    expect(h.statuses.map((s) => s.stage)).toEqual(["Started", "Completed"]);
    expect(h.statuses.at(-1)!.detail).toBe("released for delivery");
  });

  it("opens a review and does not release when the amount differs", async () => {
    h.start(payment({ amount: 200 }));
    expect(await h.run()).toEqual({ status: "completed", result: "pending: paid R$ 200.00, invoice R$ 99.90" });

    expect(h.released).toEqual([]);
    expect(h.reviews).toEqual([{ eventId: "evt_1", orderId: "P-1", reason: "paid R$ 200.00, invoice R$ 99.90" }]);
    expect(h.statuses.at(-1)).toMatchObject({
      stage: "Completed",
      detail: "pending: paid R$ 200.00, invoice R$ 99.90",
    });
  });

  it("opens a review when there is no invoice", async () => {
    h.start(payment({ orderId: "P-9", amount: 10 }));
    expect(await h.run()).toEqual({ status: "completed", result: "pending: no invoice for order P-9" });
    expect(h.released).toEqual([]);
  });

  it("opens a review when another payment already paid the invoice", async () => {
    h.invoices.set("P-1", { orderId: "P-1", amount: 99.9, paidByEvent: "evt_old" });
    h.start(payment());
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed" });
    expect(h.released).toEqual([]);
    expect(h.reviews).toHaveLength(1);
  });

  it("retries only the failed command after a transient failure", async () => {
    h.failReads = 1;
    h.start(payment());
    expect((await h.run()).status).toBe("hibernated"); // the command failed, skail re-delivers
    h.platform.enqueue("evt_1");
    const outcome = await h.run();

    expect(outcome).toEqual({ status: "completed", result: "released for delivery" });
    expect(h.released).toEqual([["P-1", "evt_1"]]);
  });

  it("notifies Failed with the message and rethrows when a command fails for good", async () => {
    h.alwaysFail = true;
    h.start(payment());
    for (let i = 0; i < 8 && !h.statuses.some((s) => s.stage === "Failed"); i++) {
      const activation =
        i === 0 ? await h.platform.consume() : (h.platform.enqueue("evt_1"), await h.platform.consume());
      if (!activation) break;
      await h.worker.runActivation(activation);
    }

    expect(h.statuses.find((s) => s.stage === "Failed")).toMatchObject({ eventId: "evt_1", detail: "web down" });
    expect(h.released).toEqual([]);
  });

  it("runs every effect through a command (the function itself does no I/O)", async () => {
    h.start(payment());
    await h.run();
    const commands = h.platform.history("evt_1").filter((f) => f.eventType === EventType.Durable);
    expect(commands.map((c) => (c.targetUri ?? "").split("/").pop())).toEqual([
      "ReportStatus",
      "SettleInvoice",
      "ReleaseForDelivery",
      "ReportStatus",
    ]);
  });
});

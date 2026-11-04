import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentConfirmed, StateView } from "@skail-payment-webhook/contracts";
import { createApp } from "../src/app.js";
import { executionIdFromEventId } from "../src/execution-ids.js";
import { SkailGatewayError, type SkailGateway } from "../src/gateway.js";
import { PaymentStore } from "../src/payment-store.js";

class FakeGateway implements SkailGateway {
  triggers: { taskId: string; payment: PaymentConfirmed }[] = [];
  failTrigger = false;
  async trigger(taskId: string, payment: PaymentConfirmed) {
    if (this.failTrigger) throw new SkailGatewayError("sidecar down");
    this.triggers.push({ taskId, payment });
  }
}

let store: PaymentStore;
let gateway: FakeGateway;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new PaymentStore();
  gateway = new FakeGateway();
  app = createApp({ store, gateway });
});

const webhook = (payload: unknown) =>
  app.inject({ method: "POST", url: "/webhooks/payments", payload: payload as object });
const pay = (eventId = "evt_1", orderId = "P-1", amount = 99.9) => webhook({ eventId, orderId, amount });

describe("POST /webhooks/payments", () => {
  it("triggers ReleaseOrder with the event id as the execution id and answers the taskId", async () => {
    const res = await pay();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ taskId: executionIdFromEventId("evt_1") });
    expect(gateway.triggers).toEqual([
      { taskId: executionIdFromEventId("evt_1"), payment: { eventId: "evt_1", orderId: "P-1", amount: 99.9 } },
    ]);
  });

  it("sends the resend to the same execution and counts the deliveries", async () => {
    await pay();
    await pay();
    const third = await pay();

    expect(new Set(gateway.triggers.map((t) => t.taskId)).size).toBe(1);
    expect(third.json().taskId).toBe(executionIdFromEventId("evt_1"));
    expect(store.snapshot().events).toHaveLength(1);
    expect(store.snapshot().events[0]!.deliveries).toBe(3);
  });

  it("uses another execution for another event", async () => {
    await pay("evt_1");
    await pay("evt_2");
    expect(new Set(gateway.triggers.map((t) => t.taskId)).size).toBe(2);
  });

  it.each([
    [{}],
    [{ eventId: "evt_1", orderId: "P-1" }],
    [{ eventId: " ", orderId: "P-1", amount: 1 }],
    [{ eventId: "evt_1", orderId: "", amount: 1 }],
    [{ eventId: "evt_1", orderId: "P-1", amount: "99.9" }],
  ])("answers 400 for the invalid payload %j", async (payload) => {
    const res = await webhook(payload);
    expect(res.statusCode).toBe(400);
    expect(gateway.triggers).toEqual([]);
  });

  it("answers 502 and shows 'NotAccepted' when skail does not accept the trigger; the resend works later", async () => {
    gateway.failTrigger = true;
    const res = await pay();

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ taskId: executionIdFromEventId("evt_1") });
    expect(store.snapshot().events[0]!.state).toBe("NotAccepted");

    gateway.failTrigger = false;
    expect((await pay()).statusCode).toBe(200);
    expect(store.snapshot().events[0]).toMatchObject({ state: "Received", deliveries: 2 });
  });
});

describe("state and reset", () => {
  it("GET /api/state returns the invoices, events and reviews", async () => {
    await pay();
    const state = (await app.inject({ url: "/api/state" })).json() as StateView;

    expect(state.invoices.map((i) => i.orderId)).toEqual(["P-1", "P-2", "P-3"]);
    expect(state.events).toHaveLength(1);
    expect(state.reviews).toEqual([]);
  });

  it("POST /api/reset goes back to the seed", async () => {
    await pay();
    expect((await app.inject({ method: "POST", url: "/api/reset" })).statusCode).toBe(204);
    expect(store.snapshot().events).toEqual([]);
  });

  it("answers /healthz", async () => {
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("internal routes (called by the worker)", () => {
  it("GET /internal/invoices/{orderId} returns the invoice, or 404", async () => {
    expect((await app.inject({ url: "/internal/invoices/P-1" })).json()).toEqual({
      orderId: "P-1",
      amount: 99.9,
      paidByEvent: null,
    });
    expect((await app.inject({ url: "/internal/invoices/P-9" })).statusCode).toBe(404);
  });

  it("POST .../paid answers 204 (and again for the same event), 409 for another event, 404 without invoice", async () => {
    const paid = (orderId: string, eventId: string) =>
      app.inject({ method: "POST", url: `/internal/invoices/${orderId}/paid`, payload: { eventId } });

    expect((await paid("P-1", "evt_1")).statusCode).toBe(204);
    expect((await paid("P-1", "evt_1")).statusCode).toBe(204);
    expect((await paid("P-1", "evt_2")).statusCode).toBe(409);
    expect((await paid("P-9", "evt_1")).statusCode).toBe(404);
  });

  it("POST .../release releases once per event", async () => {
    const release = () =>
      app.inject({ method: "POST", url: "/internal/orders/P-1/release", payload: { eventId: "evt_1" } });
    expect((await release()).statusCode).toBe(204);
    await release();
    expect(store.snapshot().invoices[0]!.releases).toBe(1);
  });

  it("POST /internal/reviews records the review", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/reviews",
      payload: { eventId: "evt_1", orderId: "P-1", reason: "x" },
    });
    expect(res.statusCode).toBe(204);
    expect(store.snapshot().reviews).toEqual([{ eventId: "evt_1", orderId: "P-1", reason: "x" }]);
  });

  it("POST .../status moves the event, using the id of the route", async () => {
    await pay();
    const status = (stage: string, detail?: string) =>
      app.inject({
        method: "POST",
        url: "/internal/events/evt_1/status",
        payload: { eventId: "ignored", stage, detail },
      });

    expect((await status("Started")).statusCode).toBe(204);
    expect(store.snapshot().events[0]!.state).toBe("Running");
    await status("Completed", "pending: no invoice for order P-1");
    expect(store.snapshot().events[0]).toMatchObject({ state: "Pending", result: "pending: no invoice for order P-1" });
  });
});

describe("GET /api/stream (SSE)", () => {
  let base: string;

  beforeEach(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    return () => app.close();
  });

  it("starts with the current snapshot and sends another one on every change", async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const snapshots: StateView[] = [];
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value, { stream: true });
      const [chunk, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      snapshots.push(JSON.parse(chunk!.replace(/^data: /, "")) as StateView);
    };

    await next();
    expect(snapshots[0]!.events).toEqual([]);

    await pay();
    await next();
    expect(snapshots[1]!.events[0]).toMatchObject({ eventId: "evt_1", deliveries: 1 });

    controller.abort();
  });
});

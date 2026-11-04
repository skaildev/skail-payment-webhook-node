import { describe, expect, it } from "vitest";
import { HttpInvoiceStore, HttpStatusNotifier } from "../src/web.js";

function recorder(...statuses: number[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 204;
    const body = status === 200 ? JSON.stringify({ orderId: "P-1", amount: 99.9, paidByEvent: null }) : null;
    return new Response(body, { status });
  };
  return { calls, fetchImpl };
}

describe("HttpInvoiceStore", () => {
  it("reads the invoice from internal/invoices/{orderId}", async () => {
    const { calls, fetchImpl } = recorder(200);
    const invoice = await new HttpInvoiceStore("http://web:8080", fetchImpl).get("P 1");

    expect(calls[0]!.url).toBe("http://web:8080/internal/invoices/P%201");
    expect(invoice).toEqual({ orderId: "P-1", amount: 99.9, paidByEvent: null });
  });

  it("gives every call a timeout, so a web app that hangs fails the command and skail retries it", async () => {
    const { calls, fetchImpl } = recorder(200, 204);
    const store = new HttpInvoiceStore("http://web:8080", fetchImpl);
    await store.get("P-1");
    await store.release("P-1", "evt_1");

    for (const call of calls) expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null when there is no invoice (404)", async () => {
    const { fetchImpl } = recorder(404);
    expect(await new HttpInvoiceStore("http://web:8080", fetchImpl).get("P-9")).toBeNull();
  });

  it("throws on any other error, so skail retries the command", async () => {
    const { fetchImpl } = recorder(500);
    await expect(new HttpInvoiceStore("http://web:8080", fetchImpl).get("P-1")).rejects.toThrow(/500/);
  });

  it("marks the invoice paid by posting the event id", async () => {
    const { calls, fetchImpl } = recorder(204);
    expect(await new HttpInvoiceStore("http://web:8080/", fetchImpl).markPaid("P-1", "evt_1")).toBe(true);

    expect(calls[0]!.url).toBe("http://web:8080/internal/invoices/P-1/paid");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ eventId: "evt_1" });
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe("application/json");
  });

  it("returns false when another payment got there first (409), and throws on other errors", async () => {
    expect(await new HttpInvoiceStore("http://web:8080", recorder(409).fetchImpl).markPaid("P-1", "evt_1")).toBe(false);
    await expect(
      new HttpInvoiceStore("http://web:8080", recorder(500).fetchImpl).markPaid("P-1", "evt_1"),
    ).rejects.toThrow(/500/);
  });

  it("releases the order and opens the review", async () => {
    const { calls, fetchImpl } = recorder(204);
    const store = new HttpInvoiceStore("http://web:8080", fetchImpl);
    await store.release("P-1", "evt_1");
    await store.addReview({ eventId: "evt_1", orderId: "P-1", reason: "x" });

    expect(calls.map((c) => c.url)).toEqual([
      "http://web:8080/internal/orders/P-1/release",
      "http://web:8080/internal/reviews",
    ]);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ eventId: "evt_1", orderId: "P-1", reason: "x" });
  });

  it("throws when the release or the review fails", async () => {
    const store = new HttpInvoiceStore("http://web:8080", recorder(500).fetchImpl);
    await expect(store.release("P-1", "e")).rejects.toThrow(/500/);
    await expect(store.addReview({ eventId: "e", orderId: "P-1", reason: "x" })).rejects.toThrow(/500/);
  });
});

describe("HttpStatusNotifier", () => {
  it("posts the status as JSON to internal/events/{id}/status", async () => {
    const { calls, fetchImpl } = recorder(204);
    await new HttpStatusNotifier("http://web:8080", fetchImpl).notify({
      eventId: "evt 1",
      stage: "Completed",
      detail: "ok",
    });

    expect(calls[0]!.url).toBe("http://web:8080/internal/events/evt%201/status");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ eventId: "evt 1", stage: "Completed", detail: "ok" });
  });

  it("throws when the web app answers an error", async () => {
    const { fetchImpl } = recorder(500);
    await expect(
      new HttpStatusNotifier("http://web:8080", fetchImpl).notify({ eventId: "e", stage: "Started" }),
    ).rejects.toThrow(/500/);
  });
});

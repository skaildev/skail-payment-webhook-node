import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SettleResult } from "./model.js";

export const alreadyPaidByAnother = "the invoice was already paid by another payment";

/**
 * The demo "database": the invoices, the deliveries and the finance reviews. In your system these would be your tables;
 * here they live in memory and print each change to the console. Every write is idempotent by event id, because a
 * retried command runs again.
 */
export class SimulatedStore {
  /** Open invoices by order id, and who paid them. P-3 was already paid by an older event. */
  private readonly invoices = new Map<string, { amount: number; paidByEvent: string | null }>([
    ["P-1", { amount: 99.9, paidByEvent: null }],
    ["P-2", { amount: 250, paidByEvent: null }],
    ["P-3", { amount: 80, paidByEvent: "evt_old" }],
  ]);
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
    print(eventId, `invoice ${orderId}: paid, ${money(amount)}`);
    return { done: true, reason: null };
  }

  release(orderId: string, eventId: string): void {
    if (this.released.has(orderId)) return;
    this.released.add(orderId);
    print(eventId, `delivery: order ${orderId} released`);
  }

  openReview(eventId: string, orderId: string, reason: string): void {
    if (this.reviews.has(eventId)) return;
    this.reviews.add(eventId);
    print(eventId, `finance: review opened for order ${orderId} (${reason})`);
  }

  /** Serves the store over HTTP on a free local port, for the commands, and returns its address. */
  listen(): Promise<string> {
    const routes: Record<string, (body: any) => unknown> = {
      "/invoices/settle": (b) => this.settle(b.eventId, b.orderId, b.amount),
      "/deliveries/release": (b) => this.release(b.orderId, b.eventId),
      "/reviews/open": (b) => this.openReview(b.eventId, b.orderId, b.reason),
    };

    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const route = routes[request.url ?? ""];
      if (!route) return void response.writeHead(404).end();
      try {
        const result = route(JSON.parse(body || "{}"));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result ?? null));
      } catch (error) {
        response.writeHead(500).end((error as Error).message);
      }
    });

    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      }),
    );
  }
}

export function money(value: number): string {
  return `R$ ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function print(eventId: string, message: string): void {
  console.log(`[${eventId}] ${message}`);
}

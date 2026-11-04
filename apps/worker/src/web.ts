import type { EventStatus, Invoice, ReviewRequest } from "@skail-payment-webhook/contracts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

/** The demo "database" the worker reads and writes: the invoices, the deliveries and the finance reviews. */
export interface InvoiceStore {
  get(orderId: string): Promise<Invoice | null>;
  /** @returns false when another event paid the invoice first. Idempotent for the same event. */
  markPaid(orderId: string, eventId: string): Promise<boolean>;
  /** Idempotent by event id: a retried command does not release the order twice. */
  release(orderId: string, eventId: string): Promise<void>;
  /** Idempotent by event id. */
  addReview(review: ReviewRequest): Promise<void>;
}

export interface StatusNotifier {
  notify(status: EventStatus): Promise<void>;
}

class WebClient {
  readonly #base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: Fetch,
  ) {
    this.#base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  post(route: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.#base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  get(route: string): Promise<Response> {
    return this.fetchImpl(`${this.#base}${route}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
}

function ensureOk(response: Response, what: string): void {
  if (!response.ok) throw new Error(`Web app answered ${response.status} to the ${what}`);
}

/** The invoices live in the web app: GET/POST {web}/internal/... */
export class HttpInvoiceStore implements InvoiceStore {
  readonly #web: WebClient;

  constructor(baseUrl: string, fetchImpl: Fetch = (url, init) => fetch(url, init)) {
    this.#web = new WebClient(baseUrl, fetchImpl);
  }

  async get(orderId: string): Promise<Invoice | null> {
    const response = await this.#web.get(`internal/invoices/${encodeURIComponent(orderId)}`);
    if (response.status === 404) return null;
    ensureOk(response, "invoice read");
    return (await response.json()) as Invoice;
  }

  async markPaid(orderId: string, eventId: string): Promise<boolean> {
    const response = await this.#web.post(`internal/invoices/${encodeURIComponent(orderId)}/paid`, { eventId });
    if (response.status === 409) return false;
    ensureOk(response, "invoice payment");
    return true;
  }

  async release(orderId: string, eventId: string): Promise<void> {
    ensureOk(
      await this.#web.post(`internal/orders/${encodeURIComponent(orderId)}/release`, { eventId }),
      "order release",
    );
  }

  async addReview(review: ReviewRequest): Promise<void> {
    ensureOk(await this.#web.post("internal/reviews", review), "review");
  }
}

/** Reports progress to the web app: POST {web}/internal/events/{id}/status. */
export class HttpStatusNotifier implements StatusNotifier {
  readonly #web: WebClient;

  constructor(baseUrl: string, fetchImpl: Fetch = (url, init) => fetch(url, init)) {
    this.#web = new WebClient(baseUrl, fetchImpl);
  }

  async notify(status: EventStatus): Promise<void> {
    ensureOk(await this.#web.post(`internal/events/${encodeURIComponent(status.eventId)}/status`, status), "status");
  }
}

// Shared by web, worker and front end. It also goes into the skail bundle, so it holds only types, constants and
// pure functions: `skail build` rejects Node I/O imports.

/** What the payment gateway sends, and the argument of the ReleaseOrder function. */
export interface PaymentConfirmed {
  eventId: string;
  orderId: string;
  amount: number;
}

/** An invoice of the demo "database" (it lives in the web app). */
export interface Invoice {
  orderId: string;
  amount: number;
  paidByEvent: string | null;
}

/** Result of the SettleInvoice command. A mismatch is a result, not an error: nothing to retry. */
export interface SettleResult {
  done: boolean;
  reason: string | null;
}

export type EventStage = "Started" | "Completed" | "Failed";

/** Progress sent by the worker to the web app (ReportStatus command). */
export interface EventStatus {
  eventId: string;
  stage: EventStage;
  detail?: string | null;
}

export interface MarkPaidRequest {
  eventId: string;
}

export interface ReleaseRequest {
  eventId: string;
}

export interface ReviewRequest {
  eventId: string;
  orderId: string;
  reason: string;
}

/** The two results of ReleaseOrder. */
export const PaymentResults = {
  released: "released for delivery",
  pendingPrefix: "pending: ",
  pending: (reason: string) => `pending: ${reason}`,
} as const;

export const AlreadyPaidByAnother = "the invoice was already paid by another payment";

/** "R$ 99.90": the same text in the reasons the worker writes and in the page. */
export function money(value: number): string {
  return `R$ ${value.toFixed(2)}`;
}

/** Amounts are compared in cents, so 99.9 and 99.90 are the same payment. */
export function sameAmount(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

export type EventState = "Received" | "NotAccepted" | "Running" | "Released" | "Pending" | "Failed";

export interface InvoiceView {
  orderId: string;
  amount: number;
  paidByEvent: string | null;
  /** How many times the order was released; more than 1 would be a duplicate delivery. */
  releases: number;
}

export interface EventView {
  eventId: string;
  orderId: string;
  amount: number;
  taskId: string;
  /** How many times the gateway delivered this event (resends land on the same execution). */
  deliveries: number;
  state: EventState;
  result: string | null;
}

export interface ReviewView {
  eventId: string;
  orderId: string;
  reason: string;
}

/** What `GET /api/state` and the SSE stream return. */
export interface StateView {
  invoices: InvoiceView[];
  events: EventView[];
  reviews: ReviewView[];
}

export function isTerminal(state: EventState): boolean {
  return state === "Released" || state === "Pending" || state === "Failed";
}

/** The state an event reaches when the worker reports it finished. */
export function stateOfResult(result: string | null | undefined): EventState {
  return result?.startsWith(PaymentResults.pendingPrefix) ? "Pending" : "Released";
}

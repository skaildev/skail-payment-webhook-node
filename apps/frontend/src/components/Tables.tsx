import { money, type EventView, type InvoiceView, type ReviewView } from "@skail-payment-webhook/contracts";

const LABELS: Record<EventView["state"], string> = {
  NotAccepted: "Not accepted",
  Received: "Received",
  Running: "Running",
  Released: "Released",
  Pending: "Pending",
  Failed: "Failed",
};

// the event id is free text: React renders it as text, never as HTML

export function InvoicesTable({ invoices }: { invoices: InvoiceView[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Order</th>
          <th>Amount</th>
          <th>Invoice</th>
          <th>Released</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((i) => (
          <tr key={i.orderId}>
            <td>{i.orderId}</td>
            <td>{money(i.amount)}</td>
            <td>{i.paidByEvent ? `paid by ${i.paidByEvent}` : "open"}</td>
            <td className={i.releases > 1 ? "dup" : undefined}>{`×${i.releases}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A delivery counter above 1 is the sign of a resend: it lands on the same execution. */
export function EventsTable({ events }: { events: EventView[] }) {
  if (events.length === 0) return <p className="empty">No payment received yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Event</th>
          <th>Order</th>
          <th>Amount</th>
          <th>Execution</th>
          <th>Received</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {[...events].reverse().map((e) => (
          <tr key={e.eventId}>
            <td className="mono">{e.eventId}</td>
            <td>{e.orderId}</td>
            <td>{money(e.amount)}</td>
            <td className="mono" title={e.taskId}>
              {e.taskId.slice(0, 8)}
            </td>
            <td className={e.deliveries > 1 ? "dup" : undefined}>{`×${e.deliveries}`}</td>
            <td>
              <span className={`badge ${e.state}`}>{LABELS[e.state]}</span>
              {e.result && <span className="result">{e.result}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReviewsTable({ reviews }: { reviews: ReviewView[] }) {
  if (reviews.length === 0) return <p className="empty">Nothing for finance to check.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Event</th>
          <th>Order</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {reviews.map((p) => (
          <tr key={p.eventId}>
            <td className="mono">{p.eventId}</td>
            <td>{p.orderId}</td>
            <td>{p.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

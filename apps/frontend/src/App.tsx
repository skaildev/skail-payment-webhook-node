import { useRef, useState } from "react";
import { money, type PaymentConfirmed, type StateView } from "@skail-payment-webhook/contracts";
import { resetDemo, sendPayment } from "./api";
import { EventsTable, InvoicesTable, ReviewsTable } from "./components/Tables";
import { useStateStream } from "./hooks/useStateStream";

const LAST_KEY = "payment-webhook.last";
const SESSION = Math.random().toString(36).slice(2, 6); // keeps event ids of this browser session apart

const SCENARIOS: { orderId: string; amount: number }[] = [
  { orderId: "P-1", amount: 99.9 },
  { orderId: "P-2", amount: 200 },
  { orderId: "P-3", amount: 80 },
  { orderId: "P-9", amount: 10 },
];

function readLast(): PaymentConfirmed | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as PaymentConfirmed | null;
  } catch {
    return null;
  }
}

export function App() {
  const [state, setState] = useState<StateView>({ invoices: [], events: [], reviews: [] });
  const [last, setLast] = useState<PaymentConfirmed | null>(readLast);
  const [sent, setSent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);

  useStateStream(setState);

  async function send(payment: PaymentConfirmed) {
    setError(null);
    setLast(payment);
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(payment));
    } catch {
      /* storage unavailable */
    }
    setSent(`sent ${payment.eventId}…`);
    try {
      const outcome = await sendPayment(payment);
      setSent(
        `${payment.eventId} → ${outcome.status}${outcome.taskId ? ` · execution ${outcome.taskId.slice(0, 8)}` : ""}`,
      );
      if (outcome.status >= 400) setError(outcome.error ?? `the webhook answered ${outcome.status}`);
    } catch (e) {
      setSent("");
      setError(`could not reach the webhook: ${(e as Error).message}`);
    }
  }

  function onScenario(orderId: string, amount: number) {
    counter.current += 1;
    void send({ eventId: `evt_${SESSION}_${counter.current}`, orderId, amount });
  }

  async function onReset() {
    setError(null);
    await resetDemo();
    setSent("");
  }

  return (
    <main>
      <header>
        <h1>Payment webhook</h1>
        <p className="subtitle">
          The gateway says a payment came in, sometimes two or three times. The event id is the execution id, so the
          resends land on the same execution and the order is released once. If the invoice does not match, finance
          reviews the payment.
        </p>
      </header>

      <section className="controls" aria-label="Payment gateway simulator">
        {SCENARIOS.map((s) => (
          <button key={s.orderId} type="button" onClick={() => onScenario(s.orderId, s.amount)}>
            {`${s.orderId} · ${money(s.amount)}`}
          </button>
        ))}
        <button type="button" className="secondary" disabled={!last} onClick={() => last && void send(last)}>
          Send again
        </button>
        <button type="button" className="secondary" onClick={() => void onReset()}>
          Reset demo
        </button>
      </section>
      {sent && <p className="sent">{sent}</p>}
      {error && <p className="error">{error}</p>}

      <h2>Invoices</h2>
      <InvoicesTable invoices={state.invoices} />

      <h2>Payments received</h2>
      <EventsTable events={state.events} />

      <h2>Finance reviews</h2>
      <ReviewsTable reviews={state.reviews} />
    </main>
  );
}

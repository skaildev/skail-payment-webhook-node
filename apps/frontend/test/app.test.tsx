import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateView } from "@skail-payment-webhook/contracts";
import { App } from "../src/App";

const state = (patch: Partial<StateView> = {}): StateView => ({
  invoices: [
    { orderId: "P-1", amount: 99.9, paidByEvent: null, releases: 0 },
    { orderId: "P-3", amount: 80, paidByEvent: "evt_old", releases: 0 },
  ],
  events: [],
  reviews: [],
  ...patch,
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: StateView) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let calls: Array<{ url: string; method: string; body?: string }>;
let answers: Record<string, () => Response>;

beforeEach(() => {
  calls = [];
  answers = {};
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new Error(`unexpected ${method} ${url}`);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stream = () => FakeEventSource.instances[0]!;

describe("App", () => {
  it("opens the SSE stream and shows the invoices of the snapshot", () => {
    render(<App />);
    expect(stream().url).toBe("/api/stream");

    stream().emit(state());
    expect(screen.getByText("R$ 99.90")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("paid by evt_old")).toBeInTheDocument();
  });

  it("closes the stream when it unmounts", () => {
    const { unmount } = render(<App />);
    unmount();
    expect(stream().closed).toBe(true);
  });

  it("starts with 'Send again' disabled and nothing received", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Send again" })).toBeDisabled();
    expect(screen.getByText("No payment received yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing for finance to check.")).toBeInTheDocument();
  });

  it("sends the scenario to the webhook like the gateway would", async () => {
    answers["POST /webhooks/payments"] = () => json({ taskId: "12345678-aaaa-bbbb-cccc-dddddddddddd" });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "P-2 · R$ 200.00" }));

    const sent = JSON.parse(calls[0]!.body!) as { eventId: string; orderId: string; amount: number };
    expect(sent).toMatchObject({ orderId: "P-2", amount: 200 });
    expect(sent.eventId).toMatch(/^evt_/);
    expect(await screen.findByText(/→ 200 · execution 12345678/)).toBeInTheDocument();
  });

  it("'Send again' repeats the same event id; each scenario click makes a new one", async () => {
    answers["POST /webhooks/payments"] = () => json({ taskId: "12345678-aaaa" });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "P-1 · R$ 99.90" }));
    await userEvent.click(screen.getByRole("button", { name: "Send again" }));
    await userEvent.click(screen.getByRole("button", { name: "P-1 · R$ 99.90" }));

    const ids = calls.map((c) => (JSON.parse(c.body!) as { eventId: string }).eventId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("shows the error when the webhook answers 502", async () => {
    answers["POST /webhooks/payments"] = () =>
      json({ taskId: "12345678-aaaa", error: "skail unavailable, resend" }, 502);
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "P-1 · R$ 99.90" }));

    expect(await screen.findByText("skail unavailable, resend")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send again" })).toBeEnabled();
  });

  it("shows the events with the resend counter, the status and the result", () => {
    render(<App />);
    stream().emit(
      state({
        events: [
          {
            eventId: "evt_1",
            orderId: "P-1",
            amount: 99.9,
            taskId: "aaaaaaaa-1111",
            deliveries: 3,
            state: "Released",
            result: "released for delivery",
          },
          {
            eventId: "evt_2",
            orderId: "P-2",
            amount: 200,
            taskId: "bbbbbbbb-2222",
            deliveries: 1,
            state: "Pending",
            result: "pending: paid R$ 200.00, invoice R$ 250.00",
          },
        ],
        reviews: [{ eventId: "evt_2", orderId: "P-2", reason: "paid R$ 200.00, invoice R$ 250.00" }],
      }),
    );

    const first = screen.getByText("evt_1").closest("tr")!;
    expect(within(first).getByText("×3")).toHaveClass("dup");
    expect(within(first).getByText("Released")).toBeInTheDocument();
    expect(within(first).getByText("aaaaaaaa")).toBeInTheDocument();

    const second = screen.getAllByText("evt_2")[0]!.closest("tr")!; // the events table comes first;
    expect(within(second).getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("paid R$ 200.00, invoice R$ 250.00")).toBeInTheDocument();
  });

  it("renders the event id as text, never as HTML", () => {
    render(<App />);
    stream().emit(
      state({
        events: [
          {
            eventId: "<img src=x onerror=alert(1)>",
            orderId: "P-1",
            amount: 1,
            taskId: "cccccccc-3333",
            deliveries: 1,
            state: "Received",
            result: null,
          },
        ],
      }),
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("'Reset demo' calls the reset endpoint", async () => {
    answers["POST /api/reset"] = () => new Response(null, { status: 204 });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Reset demo" }));

    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/reset"]));
  });
});

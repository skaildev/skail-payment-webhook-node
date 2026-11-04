import type { PaymentConfirmed } from "@skail-payment-webhook/contracts";

export interface SendOutcome {
  status: number;
  taskId?: string;
  error?: string;
}

/** The gateway simulator calls the real webhook endpoint, like the payment gateway would. */
export async function sendPayment(payment: PaymentConfirmed): Promise<SendOutcome> {
  const res = await fetch("/webhooks/payments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payment),
  });
  const body = (await res.json().catch(() => ({}))) as { taskId?: string; error?: string };
  return { status: res.status, ...body };
}

export async function resetDemo(): Promise<void> {
  await fetch("/api/reset", { method: "POST" });
}

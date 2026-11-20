// Types of the demo. This file ends up inside the skail bundle: pure code only, no Node imports.

/** What the payment gateway sends, and the argument of the ReleaseOrder function. */
export interface PaymentConfirmed {
  eventId: string;
  orderId: string;
  amount: number;
}

/** Result of the SettleInvoice command. A mismatch is a result, not an error: another attempt would not change it. */
export interface SettleResult {
  done: boolean;
  reason: string | null;
}

/** The two ways ReleaseOrder can end. */
export const PaymentResults = {
  released: "released for delivery",
  pending: (reason: string) => `pending: ${reason}`,
} as const;

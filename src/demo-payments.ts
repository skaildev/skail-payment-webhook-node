/** One payment per path, set up for the invoices of the store. Sends is how many times the gateway sends it. */
export interface DemoPayment {
  path: string;
  orderId: string;
  amount: number;
  sends: number;
  expected: string;
}

export const demoPayments: readonly DemoPayment[] = [
  {
    path: "released",
    orderId: "P-1",
    amount: 99.9,
    sends: 3,
    expected: "released once, however many times it is sent",
  },
  { path: "amount", orderId: "P-2", amount: 200, sends: 1, expected: "finance review: the amount does not match" },
  { path: "paid", orderId: "P-3", amount: 80, sends: 1, expected: "finance review: the invoice was already paid" },
  { path: "missing", orderId: "P-9", amount: 10, sends: 1, expected: "finance review: there is no invoice" },
];

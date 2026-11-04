import {
  AlreadyPaidByAnother,
  money,
  sameAmount,
  type SettleResult,
  type PaymentConfirmed,
} from "@skail-payment-webhook/contracts";
import type { InvoiceStore } from "./web.js";

/**
 * The rule of the SettleInvoice command: may this payment settle the invoice? Everything that does not match comes back
 * as a result (the money came in, so a person checks it), never as an exception. Kept out of the command so it can be
 * tested without the skail runtime.
 */
export class InvoiceSettler {
  constructor(private readonly store: InvoiceStore) {}

  async settle(payment: PaymentConfirmed): Promise<SettleResult> {
    const invoice = await this.store.get(payment.orderId);
    let result: SettleResult;
    if (!invoice) result = { done: false, reason: `no invoice for order ${payment.orderId}` };
    else if (invoice.paidByEvent === payment.eventId)
      result = { done: true, reason: null }; // a retry of this same settlement
    else if (invoice.paidByEvent !== null) result = { done: false, reason: AlreadyPaidByAnother };
    else if (!sameAmount(invoice.amount, payment.amount)) {
      result = { done: false, reason: `paid ${money(payment.amount)}, invoice ${money(invoice.amount)}` };
    } else result = { done: true, reason: null };

    // the store refuses when another event got there first (two executions for the same invoice at once)
    if (result.done && !(await this.store.markPaid(payment.orderId, payment.eventId))) {
      result = { done: false, reason: AlreadyPaidByAnother };
    }
    return result;
  }
}

import type { Invoice, AgingBucket } from "./types.js";

/** Days an invoice is past due (0 if not yet due, negative not possible here). */
export function daysOverdue(invoice: Invoice, today: Date): number {
  const due = new Date(invoice.due_date + "T00:00:00Z");
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((t - due.getTime()) / 86400000));
}

export function bucketFor(days: number): AgingBucket["bucket"] {
  if (days <= 0) return "current";
  if (days <= 7) return "1-7";
  if (days <= 14) return "8-14";
  if (days <= 30) return "15-30";
  if (days <= 60) return "31-60";
  return "60+";
}

/** Unpaid invoices (SENT / PARTIALLY_PAID) bucketed by how overdue they are. */
export function ageInvoices(invoices: Invoice[], today: Date): AgingBucket[] {
  const unpaid = invoices.filter(
    (i) => i.status === "SENT" || i.status === "PARTIALLY_PAID",
  );
  return unpaid
    .map((invoice) => {
      const days_overdue = daysOverdue(invoice, today);
      return { invoice, days_overdue, bucket: bucketFor(days_overdue) };
    })
    .sort((a, b) => b.days_overdue - a.days_overdue);
}

/** Total outstanding in a currency, across the given buckets. */
export function outstandingTotal(buckets: AgingBucket[], currency: string): number {
  return buckets
    .filter((b) => b.invoice.currency_code === currency)
    .reduce((sum, b) => sum + Number(b.invoice.amount_due), 0);
}

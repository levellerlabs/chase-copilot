import type { Invoice } from "./types.js";

export interface CashflowPoint {
  week_start: string; // ISO date (Monday)
  expected_amount: number;
  currency_code: string;
  invoice_ids: string[];
}

export interface ClientPaymentProfile {
  client_name: string;
  invoices_paid: number;
  avg_days_to_pay: number;
  on_time_rate: number; // 0-1, paid on or before due date
}

/**
 * Per-client payment behaviour from paid invoice history.
 */
export function clientProfiles(invoices: Invoice[]): ClientPaymentProfile[] {
  const byClient = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    if (inv.status !== "PAID" && inv.status !== "MARKED_AS_PAID") continue;
    const list = byClient.get(inv.client_name) ?? [];
    list.push(inv);
    byClient.set(inv.client_name, list);
  }
  const profiles: ClientPaymentProfile[] = [];
  for (const [client_name, list] of byClient) {
    const days = list.map((i) => {
      const issue = new Date(i.issue_date ?? i.due_date);
      const paid = new Date(i.paid_date ?? i.due_date);
      return Math.max(0, Math.round((paid.getTime() - issue.getTime()) / 86400000));
    });
    const onTime = list.filter((i) => (i.paid_date ?? "") <= i.due_date).length;
    profiles.push({
      client_name,
      invoices_paid: list.length,
      avg_days_to_pay: Math.round(days.reduce((a, b) => a + b, 0) / days.length),
      on_time_rate: Math.round((onTime / list.length) * 100) / 100,
    });
  }
  return profiles.sort((a, b) => a.on_time_rate - b.on_time_rate);
}

/**
 * Four-week rolling cashflow forecast for outstanding invoices.
 * Expected amount is discounted by the client's lateness; expected week comes
 * from the client's average days-to-pay, floored at the due date week.
 */
export function forecast(
  outstanding: Invoice[],
  profiles: ClientPaymentProfile[],
  today: Date,
  weeks = 4,
): CashflowPoint[] {
  const profileByClient = new Map(profiles.map((p) => [p.client_name, p]));
  const points = new Map<string, CashflowPoint>();
  const monday = (d: Date): Date => {
    const day = d.getUTCDay() || 7; // treat Sunday as 7
    const m = new Date(d);
    m.setUTCDate(d.getUTCDate() - (day - 1));
    m.setUTCHours(0, 0, 0, 0);
    return m;
  };

  for (const inv of outstanding) {
    const p = profileByClient.get(inv.client_name);
    const due = new Date(inv.due_date + "T00:00:00Z");
    const expectedDays = p ? p.avg_days_to_pay : 0;
    const expected = new Date(due);
    expected.setUTCDate(expected.getUTCDate() + expectedDays);
    if (expected < monday(today)) expected.setTime(monday(today).getTime());
    const latenessDiscount = p ? Math.min(0.5, Math.max(0, (1 - p.on_time_rate) * 0.5)) : 0.15;
    const expectedAmount = Number(inv.amount_due) * (1 - latenessDiscount);

    for (let w = 0; w < weeks; w++) {
      const ws = monday(today);
      ws.setUTCDate(ws.getUTCDate() + w * 7);
      const we = new Date(ws);
      we.setUTCDate(we.getUTCDate() + 7);
      if (expected >= ws && expected < we) {
        const key = ws.toISOString().slice(0, 10);
        const point = points.get(key) ?? {
          week_start: key,
          expected_amount: 0,
          currency_code: inv.currency_code,
          invoice_ids: [],
        };
        point.expected_amount += expectedAmount;
        point.invoice_ids.push(inv.id);
        points.set(key, point);
        break;
      }
    }
  }
  return [...points.values()]
    .map((p) => ({ ...p, expected_amount: Math.round(p.expected_amount * 100) / 100 }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
}

import type { Invoice, ChaseRecord } from "./types.js";

/**
 * The port the whole app codes against. Real implementation wraps the PayPal
 * Invoicing API + agent toolkit; the mock serves clearly-labelled sample data
 * so the product is demonstrable before keys exist (same pattern as the Qloo
 * build's sample mode).
 */
export interface PayPalPort {
  readonly mode: "live" | "sample";
  listInvoices(): Promise<Invoice[]>;
  listChases(): Promise<ChaseRecord[]>;
  /** queue an approved chase for sending; the port persists and sends it */
  sendChase(record: ChaseRecord, subject: string, body: string): Promise<{ message_id: string }>;
}

export function isSampleData(label: unknown): boolean {
  return label === "urn:sample:*";
}

const TODAY = () => new Date();

function shiftDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class MockPayPal implements PayPalPort {
  readonly mode = "sample" as const;

  private invoices: Invoice[];
  private chases: ChaseRecord[];

  constructor(now: Date = TODAY()) {
    const t = (days: number) => shiftDays(now, days);
    this.invoices = [
      {
        id: "INV-SAMPLE-001",
        client_name: "Bright harbour Design Ltd",
        client_email: "accounts at bright-harbour-sample.example",
        amount_due: "1200.00",
        currency_code: "GBP",
        due_date: t(-18),
        status: "SENT",
      },
      {
        id: "INV-SAMPLE-002",
        client_name: "Kestrel Web Co",
        client_email: "billing at kestrel-sample.example",
        amount_due: "450.00",
        currency_code: "GBP",
        due_date: t(-6),
        status: "SENT",
      },
      {
        id: "INV-SAMPLE-003",
        client_name: "Northgate Studio",
        client_email: "pay at northgate-sample.example",
        amount_due: "2200.00",
        currency_code: "GBP",
        due_date: t(-2),
        status: "SENT",
      },
      {
        id: "INV-SAMPLE-004",
        client_name: "Kestrel Web Co",
        client_email: "billing at kestrel-sample.example",
        amount_due: "680.00",
        currency_code: "GBP",
        due_date: t(-40),
        status: "PAID",
        paid_amount: "680.00",
        paid_date: t(-33),
      },
      {
        id: "INV-SAMPLE-005",
        client_name: "Harbour Lights Media",
        client_email: "ap at harbourlights-sample.example",
        amount_due: "940.00",
        currency_code: "GBP",
        due_date: t(-9),
        status: "SENT",
      },
    ];
    this.chases = [
      {
        invoice_id: "INV-SAMPLE-001",
        stage: "polite_reminder",
        sent_at: t(-14) + "T09:00:00Z",
        approved_by: "sample-approval",
      },
      {
        invoice_id: "INV-SAMPLE-001",
        stage: "firm_followup",
        sent_at: t(-8) + "T09:00:00Z",
        approved_by: "sample-approval",
      },
    ];
  }

  async listInvoices(): Promise<Invoice[]> {
    return this.invoices.map((i) => ({ ...i }));
  }

  async listChases(): Promise<ChaseRecord[]> {
    return this.chases.map((c) => ({ ...c }));
  }

  async sendChase(
    record: ChaseRecord,
    _subject: string,
    _body: string,
  ): Promise<{ message_id: string }> {
    this.chases.push(record);
    return { message_id: `sample-${this.chases.length}` };
  }
}

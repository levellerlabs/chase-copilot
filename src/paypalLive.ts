import type { PayPalPort } from "./port.js";
import type { Invoice, ChaseRecord } from "./types.js";

/**
 * Live PayPalPort over the PayPal Invoicing API v2 (sandbox first).
 *
 * Activation is env-driven: PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET. Without
 * them portFromEnv returns null and the app keeps serving clearly-labelled
 * sample data (same pattern as the Qloo build). No keys, no live calls.
 *
 * Sandbox:  https://api-m.sandbox.paypal.com
 * Live:     https://api-m.paypal.com  (only with PAYPAL_ENV=live; the
 *           hackathon runs sandbox only, no real money anywhere)
 */

export interface PayPalPortConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export function portFromEnv(
  env: Record<string, string | undefined>,
): (PayPalPortConfig & { port: PayPalPort }) | null {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const baseUrl =
    env.PAYPAL_ENV === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";
  return { clientId, clientSecret, baseUrl, port: null as unknown as PayPalPort };
}

const STATUS_MAP: Record<string, Invoice["status"]> = {
  DRAFT: "DRAFT",
  SCHEDULED: "SENT",
  SENT: "SENT",
  PAID: "PAID",
  MARKED_AS_PAID: "MARKED_AS_PAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  CANCELLED: "CANCELLED",
};

interface TokenCache {
  value: string;
  expiresAt: number; // epoch ms
}

/** minimal structural types for the two API payloads we consume */
interface PayPalInvoiceSummary {
  id: string;
  status?: string;
  issue_date?: string;
  due_date?: string;
  amount?: { value?: string; currency_code?: string };
  due_amount?: { value?: string; currency_code?: string };
  paid_amount?: { value?: string; currency_code?: string };
  primary_recipients?: Array<{
    billing_info?: {
      name?: { full_name?: string };
      business_name?: string;
      email_address?: string;
    };
  }>;
}

export class LivePayPal implements PayPalPort {
  readonly mode = "live" as const;

  private readonly cfg: PayPalPortConfig;
  private tokenCache: TokenCache | null = null;
  private chases: ChaseRecord[] = [];
  private readonly fetchFn: typeof fetch;

  constructor(cfg: PayPalPortConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  private async token(now: number = Date.now()): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.value;
    }
    const res = await this.fetchFn(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(`paypal_oauth_failed status=${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.tokenCache = {
      value: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return this.tokenCache.value;
  }

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const tok = await this.token();
    const res = await this.fetchFn(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`paypal_api_failed status=${res.status} path=${path} body=${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listInvoices(): Promise<Invoice[]> {
    const data = await this.api<{ items?: PayPalInvoiceSummary[] }>(
      "GET",
      "/v2/invoicing/invoices?page=1&page_size=100&total_required=true",
    );
    return (data.items ?? []).map((inv) => {
      const recipient = inv.primary_recipients?.[0]?.billing_info;
      const status = (inv.status && STATUS_MAP[inv.status]) || "SENT";
      return {
        id: inv.id,
        client_name:
          recipient?.name?.full_name || recipient?.business_name || "Unknown client",
        client_email: recipient?.email_address || "",
        amount_due: inv.due_amount?.value ?? inv.amount?.value ?? "0.00",
        currency_code:
          inv.due_amount?.currency_code ?? inv.amount?.currency_code ?? "",
        issue_date: inv.issue_date,
        due_date: inv.due_date ?? "",
        status,
        paid_amount: inv.paid_amount?.value,
      } satisfies Invoice;
    });
  }

  async listChases(): Promise<ChaseRecord[]> {
    return this.chases.map((c) => ({ ...c }));
  }

  /**
   * PayPal Invoicing has a first-class "remind the payer" endpoint, which is
   * exactly a chase send. message_id is our own correlation id (the endpoint
   * returns 204 No Content), generated before the call.
   */
  async sendChase(
    record: ChaseRecord,
    subject: string,
    body: string,
  ): Promise<{ message_id: string }> {
    const messageId =
      globalThis.crypto?.randomUUID?.() ?? `remind-${Date.now()}`;
    await this.api(
      "POST",
      `/v2/invoicing/invoices/${encodeURIComponent(record.invoice_id)}/remind`,
      { subject, note: body, send_to_invoicer: false },
    );
    this.chases.push({ ...record, message_id: messageId });
    return { message_id: messageId };
  }
}

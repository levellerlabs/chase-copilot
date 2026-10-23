import { afterEach, describe, expect, it, vi } from "vitest";
import { LivePayPal, portFromEnv } from "../src/paypalLive.js";
import type { ChaseRecord } from "../src/types.js";

const CFG = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  baseUrl: "https://api-m.sandbox.paypal.com",
};

function jsonResponse(status: number, body: unknown, statusText = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const TOKEN_RESPONSE = jsonResponse(200, {
  access_token: "tok123",
  expires_in: 32400,
});

const FIXTURE_INVOICE = {
  id: "INV2-TEST-0001",
  status: "SENT",
  issue_date: "2026-10-01",
  due_date: "2026-10-05",
  amount: { value: "1200.00", currency_code: "GBP" },
  due_amount: { value: "1200.00", currency_code: "GBP" },
  primary_recipients: [
    {
      billing_info: {
        name: { full_name: "Dana Tester" },
        business_name: "Dana Design Ltd",
        email_address: "sample-recipient-dana",
      },
    },
  ],
};

describe("portFromEnv", () => {
  it("returns null without credentials", () => {
    expect(portFromEnv({})).toBeNull();
    expect(portFromEnv({ PAYPAL_CLIENT_ID: "x" })).toBeNull();
  });

  it("defaults to sandbox base url", () => {
    const cfg = portFromEnv({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "sec" });
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });

  it("uses live base url only with PAYPAL_ENV=live", () => {
    const cfg = portFromEnv({
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "sec",
      PAYPAL_ENV: "live",
    });
    expect(cfg!.baseUrl).toBe("https://api-m.paypal.com");
  });
});

describe("LivePayPal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and caches the oauth token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(TOKEN_RESPONSE);
    const pp = new LivePayPal(CFG, fetchMock as unknown as typeof fetch);
    const t1 = await pp["token"]();
    const t2 = await pp["token"]();
    expect(t1).toBe("tok123");
    expect(t2).toBe("tok123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("test-client-id:test-client-secret")}`,
    );
    expect(init.body).toBe("grant_type=client_credentials");
  });

  it("throws a clean error on oauth failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const pp = new LivePayPal(CFG, fetchMock as unknown as typeof fetch);
    await expect(pp["token"]()).rejects.toThrow("paypal_oauth_failed status=401");
  });

  it("maps the v2 invoice list onto our Invoice shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_RESPONSE)
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [FIXTURE_INVOICE], total_items: 1 }),
      );
    const pp = new LivePayPal(CFG, fetchMock as unknown as typeof fetch);
    const invoices = await pp.listInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      id: "INV2-TEST-0001",
      client_name: "Dana Tester",
      client_email: "sample-recipient-dana",
      amount_due: "1200.00",
      currency_code: "GBP",
      due_date: "2026-10-05",
      status: "SENT",
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/v2/invoicing/invoices?");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
  });

  it("sends a chase through the remind endpoint and records it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_RESPONSE)
      .mockResolvedValueOnce(jsonResponse(204, {}));
    const pp = new LivePayPal(CFG, fetchMock as unknown as typeof fetch);
    const record: ChaseRecord = {
      invoice_id: "INV2-TEST-0001",
      stage: "polite_reminder",
      sent_at: "2026-10-23T06:00:00Z",
      approved_by: "joe",
    };
    const { message_id } = await pp.sendChase(record, "Invoice INV2-TEST-0001", "Friendly nudge");
    expect(message_id).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(
      "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-TEST-0001/remind",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      subject: "Invoice INV2-TEST-0001",
      note: "Friendly nudge",
      send_to_invoicer: false,
    });
    const chases = await pp.listChases();
    expect(chases).toHaveLength(1);
    expect(chases[0].message_id).toBe(message_id);
  });

  it("surfaces api errors with status and path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_RESPONSE)
      .mockResolvedValueOnce(jsonResponse(403, { message: "nope" }));
    const pp = new LivePayPal(CFG, fetchMock as unknown as typeof fetch);
    await expect(pp.listInvoices()).rejects.toThrow(
      "paypal_api_failed status=403 path=/v2/invoicing/invoices",
    );
  });
});

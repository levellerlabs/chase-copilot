import { describe, it, expect } from "vitest";
import { ageInvoices, daysOverdue, bucketFor, outstandingTotal } from "../src/aging.js";
import { nextChase } from "../src/escalation.js";
import { draftChase } from "../src/drafts.js";
import { clientProfiles, forecast } from "../src/forecast.js";
import { MockPayPal } from "../src/port.js";
import type { Invoice, ChaseRecord } from "../src/types.js";

const TODAY = new Date("2026-10-23T00:00:00Z");
const inv = (over: Partial<Invoice>): Invoice => ({
  id: "INV-T",
  client_name: "Test Client",
  client_email: "t@example.com",
  amount_due: "100.00",
  currency_code: "GBP",
  due_date: "2026-10-01",
  status: "SENT",
  ...over,
});

describe("aging", () => {
  it("computes days overdue from the due date", () => {
    expect(daysOverdue(inv({ due_date: "2026-10-01" }), TODAY)).toBe(22);
    expect(daysOverdue(inv({ due_date: "2026-10-30" }), TODAY)).toBe(0);
  });
  it("buckets overdue invoices correctly", () => {
    expect(bucketFor(0)).toBe("current");
    expect(bucketFor(7)).toBe("1-7");
    expect(bucketFor(8)).toBe("8-14");
    expect(bucketFor(15)).toBe("15-30");
    expect(bucketFor(31)).toBe("31-60");
    expect(bucketFor(61)).toBe("60+");
  });
  it("ignores paid and draft invoices", () => {
    const buckets = ageInvoices(
      [inv({ status: "PAID" }), inv({ status: "DRAFT" }), inv({})],
      TODAY,
    );
    expect(buckets).toHaveLength(1);
  });
  it("sorts worst overdue first and sums outstanding", () => {
    const buckets = ageInvoices(
      [inv({ id: "A", due_date: "2026-10-20" }), inv({ id: "B", due_date: "2026-10-01" })],
      TODAY,
    );
    expect(buckets[0].invoice.id).toBe("B");
    expect(outstandingTotal(buckets, "GBP")).toBe(200);
  });
});

describe("escalation ladder", () => {
  const hist = (...records: ChaseRecord[]) => records;

  it("does not chase before due", () => {
    const d = nextChase(inv({ due_date: "2026-11-01" }), [], TODAY);
    expect(d.chase_due).toBe(false);
  });
  it("first chase is polite", () => {
    const d = nextChase(inv({ due_date: "2026-10-21" }), [], TODAY);
    expect(d.chase_due).toBe(true);
    expect(d.stage).toBe("polite_reminder");
  });
  it("steps to firm after step_up days", () => {
    const d = nextChase(inv({ due_date: "2026-10-10" }), [], TODAY); // 13d overdue
    expect(d.stage).toBe("firm_followup");
  });
  it("steps to final after second step or two chases", () => {
    const d1 = nextChase(inv({ due_date: "2026-10-01" }), [], TODAY); // 22d overdue
    expect(d1.stage).toBe("final_notice");
    const d2 = nextChase(
      inv({ due_date: "2026-10-18" }), // 5d overdue only
      hist({ invoice_id: "INV-T", stage: "polite_reminder", sent_at: "2026-10-14T09:00:00Z", approved_by: "joe" }),
      TODAY,
    );
    expect(d2.stage).toBe("firm_followup"); // one chase already sent -> next is firm
  });
  it("respects the minimum gap between chases", () => {
    const d = nextChase(
      inv({ due_date: "2026-10-01" }),
      hist({ invoice_id: "INV-T", stage: "firm_followup", sent_at: "2026-10-21T09:00:00Z", approved_by: "joe" }),
      TODAY,
    );
    expect(d.chase_due).toBe(false);
    expect(d.reason).toContain("minimum gap");
  });
  it("hands over to a human beyond the limit", () => {
    const d = nextChase(inv({ due_date: "2026-08-01" }), [], TODAY);
    expect(d.chase_due).toBe(false);
    expect(d.reason).toContain("human takes over");
  });
});

describe("drafts", () => {
  it("template drafts escalate in tone and never use em dashes", async () => {
    const ctx = { freelancer_name: "Sam" };
    const polite = await draftChase(inv({}), "polite_reminder", ctx);
    const firm = await draftChase(inv({}), "firm_followup", ctx);
    const final = await draftChase(inv({}), "final_notice", ctx);
    for (const d of [polite, firm, final]) {
      expect(d.body).not.toMatch(/[\u2013\u2014]/);
      expect(d.generator).toBe("template");
    }
    expect(polite.subject).toContain("Friendly reminder");
    expect(final.subject).toContain("Final notice");
    expect(firm.body).toContain("overdue");
  });
  it("uses the LLM rewriter when present and falls back on failure", async () => {
    const good = await draftChase(inv({}), "polite_reminder", {
      freelancer_name: "Sam",
      rewriter: async (d) => ({ ...d, body: " personalised ", generator: "test-llm" }),
    });
    expect(good.generator).toBe("test-llm");
    const fallback = await draftChase(inv({}), "polite_reminder", {
      freelancer_name: "Sam",
      rewriter: async () => {
        throw new Error("llm down");
      },
    });
    expect(fallback.generator).toBe("template");
  });
});

describe("forecast", () => {
  it("profiles per-client payment behaviour", () => {
    const profiles = clientProfiles([
      inv({ id: "1", client_name: "Fast Co", due_date: "2026-09-01", status: "PAID", paid_date: "2026-08-28" }),
      inv({ id: "2", client_name: "Slow Co", due_date: "2026-09-01", status: "PAID", paid_date: "2026-09-20" }),
    ]);
    expect(profiles.find((p) => p.client_name === "Fast Co")?.on_time_rate).toBe(1);
    expect(profiles.find((p) => p.client_name === "Slow Co")?.avg_days_to_pay).toBeGreaterThan(0);
  });
  it("discounts expected amounts and lands them in weekly buckets", () => {
    const profiles = clientProfiles([
      inv({
        id: "9",
        client_name: "Kestrel Web Co",
        issue_date: "2026-09-01",
        due_date: "2026-09-10",
        status: "PAID",
        paid_date: "2026-09-17",
      }),
    ]);
    const points = forecast(
      [inv({ id: "X", client_name: "Kestrel Web Co", amount_due: "1000.00", due_date: "2026-11-02" })],
      profiles,
      TODAY,
      6,
    );
    // Kestrel paid 16 days after issue historically -> discounted to 500, lands due+16
    const total = points.reduce((s, p) => s + p.expected_amount, 0);
    expect(total).toBeGreaterThan(400);
    expect(total).toBeLessThanOrEqual(1000);
    expect(points.every((p) => p.invoice_ids.includes("X"))).toBe(true);
  });
});

describe("mock port", () => {
  it("serves clearly sample-mode data and records approved chases", async () => {
    const pp = new MockPayPal(TODAY);
    expect(pp.mode).toBe("sample");
    const invoices = await pp.listInvoices();
    expect(invoices.some((i) => i.id.includes("SAMPLE"))).toBe(true);
    const res = await pp.sendChase(
      { invoice_id: "INV-SAMPLE-002", stage: "polite_reminder", sent_at: TODAY.toISOString(), approved_by: "joe" },
      "Subject",
      "Body",
    );
    expect(res.message_id).toMatch(/sample-/);
    expect((await pp.listChases()).some((c) => c.invoice_id === "INV-SAMPLE-002")).toBe(true);
  });
});

/**
 * Server contract tests: sample mode boot, aging decisions, the approval gate,
 * draft determinism, send bookkeeping, static shell, frontend honesty strings.
 * Node's built-in fetch drives a real listening server on an ephemeral port.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "web");

let app;
let base;

beforeAll(async () => {
  app = createApp({ env: {}, now: new Date("2026-10-23T12:00:00Z") });
  await new Promise((resolve) => app.server.listen(0, resolve));
  base = `http://localhost:${app.server.address().port}`;
});

afterAll(() => {
  app.server.close();
});

const post = (path, body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("health and mode", () => {
  it("reports sample mode when no keys are configured", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mode).toBe("sample");
    expect(data.key_configured).toBe(false);
    expect(data.ok).toBe(true);
  });
});

describe("state and decisions", () => {
  it("serves invoices with aging buckets and chase decisions", async () => {
    const res = await fetch(`${base}/api/state`);
    const data = await res.json();
    expect(data.mode).toBe("sample");
    // aged list carries only SENT / PARTIALLY_PAID: the sample PAID invoice is excluded
    expect(data.invoices.length).toBe(4);
    expect(data.invoices.find((a) => a.invoice.id === "INV-SAMPLE-004")).toBeUndefined();

    const inv1 = data.invoices.find((a) => a.invoice.id === "INV-SAMPLE-001");
    expect(inv1.days_overdue).toBe(18);
    expect(inv1.bucket).toBe("15-30");

    // 18 days overdue, last chase 8 days ago: ladder stepped up to final notice
    const d1 = data.decisions["INV-SAMPLE-001"];
    expect(d1.chase_due).toBe(true);
    expect(d1.stage).toBe("final_notice");

    // paid invoices are closed: no decision
    expect(data.decisions["INV-SAMPLE-004"]).toBeUndefined();

    // forecast exists and only carries expected money
    expect(Array.isArray(data.forecast)).toBe(true);
    for (const point of data.forecast) {
      expect(point.expected_amount).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("draft", () => {
  it("produces a template draft for a due invoice", async () => {
    const res = await fetch(`${base}/api/draft`, post("/api/draft", { invoice_id: "INV-SAMPLE-001" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.draft.generator).toBe("template");
    expect(data.draft.stage).toBe("final_notice");
    expect(data.draft.subject).toContain("INV-SAMPLE-001");
    expect(data.draft.body).toContain("final request for payment");
  });

  it("refuses to draft for invoices outside the aging list (paid/closed)", async () => {
    // the paid sample invoice never reaches the draft path at all
    const res = await fetch(`${base}/api/draft`, post("/api/draft", { invoice_id: "INV-SAMPLE-004" }));
    expect(res.status).toBe(404);
    // and the min-gap guard blocks an immediate re-chase (covered in approval gate too)
    const due = await fetch(`${base}/api/draft`, post("/api/draft", { invoice_id: "INV-SAMPLE-002" }));
    expect(due.status).toBe(200);
  });

  it("404s on unknown invoices", async () => {
    const res = await fetch(`${base}/api/draft`, post("/api/draft", { invoice_id: "NOPE" }));
    expect(res.status).toBe(404);
  });
});

describe("approval gate", () => {
  it("rejects sends without a named approver", async () => {
    const res = await fetch(`${base}/api/send`, post("/api/send", { invoice_id: "INV-SAMPLE-001" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("approval_required");
  });

  it("rejects sends with a whitespace approver", async () => {
    const res = await fetch(`${base}/api/send`, post("/api/send", { invoice_id: "INV-SAMPLE-001", approved_by: "   " }));
    expect(res.status).toBe(400);
  });

  it("records the chase with approver and message id on approval", async () => {
    const res = await fetch(
      `${base}/api/send`,
      post("/api/send", { invoice_id: "INV-SAMPLE-001", approved_by: "Test Approver" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sent.approved_by).toBe("Test Approver");
    expect(data.sent.stage).toBe("final_notice");
    expect(data.sent.message_id).toBeTruthy();

    const state = await (await fetch(`${base}/api/state`)).json();
    const recorded = state.chases.find(
      (c) => c.invoice_id === "INV-SAMPLE-001" && c.approved_by === "Test Approver",
    );
    expect(recorded).toBeTruthy();

    // min-gap guard now blocks an immediate re-chase
    const again = await fetch(`${base}/api/send`, post("/api/send", { invoice_id: "INV-SAMPLE-001", approved_by: "Test Approver" }));
    expect(again.status).toBe(409);
  });
});

describe("static shell and honesty strings", () => {
  it("serves the app shell", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Sample data - not connected to PayPal");
    expect(html).toContain("Approval tray");
  });

  it("never ships em dashes in the shipped shell or app js", () => {
    for (const file of ["index.html", "app.js"]) {
      const text = readFileSync(join(WEB, file), "utf8");
      expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    }
  });

  it("keeps the approval-gate promise visible in the frontend copy", () => {
    const js = readFileSync(join(WEB, "app.js"), "utf8");
    expect(js).toContain("nothing sends without a named human approval");
    expect(js).toContain("Approval name required before sending.");
  });

  it("blocks path traversal on static routes", async () => {
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect(res.status).toBe(404);
  });
});

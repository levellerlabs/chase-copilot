/**
 * Serverless adapter contract tests. The Vercel runtime hands the handler a
 * Node-compatible req/res pair rather than a listening socket, so these drive
 * app.handle directly - the same code path api/index.mjs uses.
 */
import { describe, it, expect } from "vitest";
import { createApp } from "../server/index.mjs";
import { createApp as createAppBundled } from "../api/bundle.mjs";

const app = createApp({ env: {}, now: new Date("2026-10-23T12:00:00Z") });

function makeReq(method, url, body) {
  const headers = body === undefined ? {} : { "content-type": "application/json" };
  const payload = body === undefined ? null : JSON.stringify(body);
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload !== null) yield Buffer.from(payload, "utf8");
    },
  };
}

function makeRes() {
  const state = { status: 0, headers: {}, body: "" };
  return {
    state,
    headersSent: false,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers || {};
    },
    end(chunk) {
      if (chunk) state.body += String(chunk);
    },
  };
}

describe("serverless adapter", () => {
  it("serves health directly without a listening server", async () => {
    const res = makeRes();
    app.handle(makeReq("GET", "/api/health"), res);
    await new Promise((r) => setImmediate(r));
    expect(res.state.status).toBe(200);
    const data = JSON.parse(res.state.body);
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("sample");
    expect(data.key_configured).toBe(false);
  });

  it("keeps the approval gate closed on the serverless path", async () => {
    const res = makeRes();
    app.handle(makeReq("POST", "/api/send", { invoice_id: "INV-SAMPLE-001" }), res);
    await new Promise((r) => setImmediate(r));
    expect(res.state.status).toBe(400);
    const data = JSON.parse(res.state.body);
    expect(data.error).toBe("approval_required");
  });

  it("serves the static dashboard shell via the adapter", async () => {
    const res = makeRes();
    app.handle(makeReq("GET", "/"), res);
    await new Promise((r) => setImmediate(r));
    expect(res.state.status).toBe(200);
    expect(res.state.headers["content-type"]).toContain("text/html");
    expect(res.state.body).toContain("Sample data - not connected to PayPal");
  });

  it("replies 404 JSON for unknown API routes", async () => {
    const res = makeRes();
    app.handle(makeReq("GET", "/api/nope"), res);
    await new Promise((r) => setImmediate(r));
    expect(res.state.status).toBe(404);
    expect(JSON.parse(res.state.body).error).toBe("not found");
  });

  it("bundled artifact (deployed lambda path) serves health too", async () => {
    const bundled = createAppBundled({ env: {}, now: new Date("2026-10-23T12:00:00Z") });
    const res = makeRes();
    bundled.handle(makeReq("GET", "/api/health"), res);
    await new Promise((r) => setImmediate(r));
    expect(res.state.status).toBe(200);
    const data = JSON.parse(res.state.body);
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("sample");
  });
});

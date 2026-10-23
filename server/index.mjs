/**
 * Chase server: thin HTTP layer over the Chase domain library.
 *
 * Port selection is env-gated: with PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET set
 * it runs against the PayPal sandbox (LivePayPal); without keys it serves the
 * clearly-labelled sample port so the product is demonstrable end to end before
 * credentials exist. Nothing ever sends without a named human approver.
 */
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MockPayPal } from "../dist/port.js";
import { LivePayPal } from "../dist/paypalLive.js";
import { ageInvoices, daysOverdue } from "../dist/aging.js";
import { nextChase } from "../dist/escalation.js";
import { draftChase } from "../dist/drafts.js";
import { clientProfiles, forecast } from "../dist/forecast.js";
import { DEFAULT_ESCALATION } from "../dist/types.js";

function resolveWebDir() {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "web"),
    join(process.cwd(), "web"),
    join(process.cwd(), "..", "web"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return candidates[0];
}

const WEB_DIR = resolveWebDir();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const SENDER_NAME = process.env.CHASE_SENDER_NAME || "Alex Morgan";

export function buildPort(env, now = new Date()) {
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    const baseUrl =
      env.PAYPAL_ENV === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com";
    return new LivePayPal({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      baseUrl,
    });
  }
  return new MockPayPal(now);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function staticFile(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
}

/**
 * Creates the HTTP server. Dependencies are injectable for tests:
 * env (port selection), now (clock), port (explicit PayPalPort override).
 */
export function createApp({ env = process.env, now = new Date(), port } = {}) {
  const paypal = port ?? buildPort(env, now);
  const keyConfigured = Boolean(
    (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) || port !== undefined,
  );

  async function snapshot() {
    const [invoices, chases] = await Promise.all([
      paypal.listInvoices(),
      paypal.listChases(),
    ]);
    const aged = ageInvoices(invoices, now);
    const decisions = {};
    for (const inv of invoices) {
      if (inv.status === "PAID" || inv.status === "MARKED_AS_PAID" || inv.status === "CANCELLED") {
        continue;
      }
      decisions[inv.id] = nextChase(inv, chases, now);
    }
    const outstanding = aged.filter((a) => a.invoice.status === "SENT" || a.invoice.status === "PARTIALLY_PAID").map((a) => a.invoice);
    const profiles = clientProfiles(invoices);
    return { invoices: aged, chases, decisions, profiles, forecast: forecast(outstanding, profiles, now) };
  }

  async function handleApi(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        mode: paypal.mode,
        key_configured: paypal.mode === "live",
        app: "chase",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const snap = await snapshot();
      return json(res, 200, { mode: paypal.mode, ...snap });
    }

    if (req.method === "POST" && url.pathname === "/api/draft") {
      const body = await readBody(req);
      if (!body || typeof body.invoice_id !== "string") {
        return json(res, 400, { error: "invoice_id required" });
      }
      const snap = await snapshot();
      const invoice = snap.invoices.find((a) => a.invoice.id === body.invoice_id);
      if (!invoice) return json(res, 404, { error: "invoice not found" });
      const decision = snap.decisions[body.invoice_id];
      if (!decision || !decision.chase_due) {
        return json(res, 409, { error: "chase not due", reason: decision ? decision.reason : "invoice closed" });
      }
      const draft = await draftChase(invoice.invoice, decision.stage, {
        freelancer_name: SENDER_NAME,
      });
      return json(res, 200, { mode: paypal.mode, decision, draft });
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await readBody(req);
      if (!body || typeof body.invoice_id !== "string") {
        return json(res, 400, { error: "invoice_id required" });
      }
      if (typeof body.approved_by !== "string" || body.approved_by.trim().length < 2) {
        return json(res, 400, { error: "approval_required", detail: "a named human approver is required before anything sends" });
      }
      const snap = await snapshot();
      const invoice = snap.invoices.find((a) => a.invoice.id === body.invoice_id);
      if (!invoice) return json(res, 404, { error: "invoice not found" });
      const decision = snap.decisions[body.invoice_id];
      if (!decision || !decision.chase_due) {
        return json(res, 409, { error: "chase not due", reason: decision ? decision.reason : "invoice closed" });
      }
      const draft = await draftChase(invoice.invoice, decision.stage, {
        freelancer_name: SENDER_NAME,
      });
      const record = {
        invoice_id: invoice.invoice.id,
        stage: decision.stage,
        sent_at: now.toISOString(),
        approved_by: body.approved_by.trim(),
      };
      const sent = await paypal.sendChase(
        record,
        typeof body.subject === "string" && body.subject.trim() ? body.subject : draft.subject,
        typeof body.body === "string" && body.body.trim() ? body.body : draft.body,
      );
      return json(res, 200, {
        mode: paypal.mode,
        sent: { ...record, message_id: sent.message_id },
      });
    }

    return json(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  /**
   * Routes one request without owning a listening socket. The Node server
   * delegates here; the Vercel serverless adapter calls it directly with the
   * platform's Node req/res pair.
   */
  function handle(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const run = url.pathname.startsWith("/api/")
      ? handleApi(req, res, url)
      : new Promise((resolve) => {
          if (req.method !== "GET") {
            res.writeHead(405, { "content-type": "text/plain" });
            res.end("method not allowed");
          } else {
            staticFile(res, url.pathname);
          }
          resolve();
        });
    run.catch((err) => {
      if (!res.headersSent) {
        json(res, 500, { error: "internal", detail: String(err && err.message ? err.message : err) });
      } else {
        res.end();
      }
    });
  }

  return { server, handle, mode: paypal.mode, keyConfigured, config: DEFAULT_ESCALATION };
}

export function start(opts) {
  const app = createApp(opts);
  const listenPort = Number((opts && opts.listenPort) || process.env.PORT || 8787);
  return new Promise((resolve) => {
    app.server.listen(listenPort, () => resolve(app));
  });
}

/* Direct run: node server/index.mjs */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().then((app) => {
    console.log(`chase listening on :${process.env.PORT || 8787} mode=${app.mode}`);
  });
}

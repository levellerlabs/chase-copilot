/**
 * Vercel serverless adapter: one warm Node function serving both the JSON API
 * and the static dashboard shell (the router handles both).
 *
 * The app is bundled to api/bundle.mjs before deploy (npm run build:vercel) so
 * the lambda is self-contained: the repo keeps dist/ git-ignored and the CLI
 * upload honours that. The bundle is generated, never hand-edited.
 *
 * The Chase app is cached at module scope so sample state (approved sends,
 * chase history) survives warm invocations. Cold starts re-seed the
 * clearly-labelled sample data by design; nothing sends without a named human
 * approver either way. When PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET are set as
 * project environment variables the same function runs against the PayPal API
 * instead of the sample port - no code change.
 */
import { createApp } from "./bundle.mjs";

let app;

function getApp() {
  if (!app) {
    app = createApp({ env: process.env });
  }
  return app;
}

export default function handler(req, res) {
  getApp().handle(req, res);
}

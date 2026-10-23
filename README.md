# Chase - PayPal AI Hackathon Entry

AI collections copilot for freelancers: aging-bucketed PayPal invoices, an
escalation ladder that drafts the next chase at the right stage, a human
approval gate before anything sends, and a client-behaviour cashflow forecast.

Runs in two modes with zero code change:

- **Sample mode** (default, no credentials): serves clearly-labelled sample
  invoices so the full product loop is demonstrable end to end. Every sample
  name, invoice id and client address is marked as illustrative.
- **Live mode**: set `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` (+ optional
  `PAYPAL_ENV=live`, default sandbox) and the same API runs against the PayPal
  Invoicing API via an OAuth2 client-credentials port with token caching.

Live demo: https://chase-copilot.vercel.app

## The approval gate is load-bearing

Nothing sends without a named human approver. The client refuses to open the
send tray without a name, the API rejects `approved_by` shorter than two
characters server-side, and every send records who approved it and when.
The LLM rewrite step is a drop-in: chase copy starts from deterministic,
plain-tone templates per escalation stage.

## Architecture

```
src/            domain library (TypeScript, no runtime deps)
  aging.ts        invoice aging buckets (current / 1-14 / 15-30 / 31-60 / 60+)
  escalation.ts   chase ladder: reminder -> follow-up -> final notice -> handover
  drafts.ts       stage-specific plain-tone chase copy
  forecast.ts     client payment profiles + landing-week cashflow forecast
  port.ts         PayPalPort interface + MockPayPal (sample data)
  paypalLive.ts   LivePayPal: OAuth2 + Invoicing v2 + remind-based chase send
server/index.mjs  HTTP layer: JSON API + static shell, injectable port/clock
api/index.mjs     Vercel serverless adapter (warm singleton, bundled artifact)
web/              dashboard: AG Grid aging table, draft/edit/approve tray, forecast
tests/            vitest: domain, live port contract, server, serverless adapter
```

## Run locally

```bash
npm install
npm run build        # tsc -> dist/
npm test             # 40 tests
npm start            # http://localhost:8787 (sample mode)
```

Live mode locally:

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYPAL_ENV=sandbox npm start
```

## Deploy (Vercel)

```bash
npm run build:vercel   # esbuild single-file lambda bundle -> api/bundle.mjs
vercel deploy --prod
```

Static shell is served from the CDN; API paths hit one Node function. Set the
PayPal variables as project environment variables to switch the function to
live mode.

## License

MIT

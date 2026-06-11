# Webhooks

Local-first webhook generator for creating local webhook endpoints, queueing incoming deliveries, inspecting redacted payload previews, and manually releasing selected queued deliveries in simulated mode.

## Boundaries

- Local development defaults to loopback backend binding. Production review deployments bind to Render's `$PORT` and serve the built Vite app from the same Node service.
- Public review deploys are allowed only for the approved deployment task. Custom domains, paid expansion, and broader production webhook use need separate approval.
- `Release webhooks` is simulated in this build. It does not send outbound HTTP requests.
- New endpoints default to inactive.
- Inactive or auth-failed attempts store metadata only; request bodies are not retained.
- Supported JSON, text, and form payloads are accepted up to 1 MB.
- Binary and multipart payloads are summarized as blocked metadata-only deliveries.
- Full payload retention is bounded to 7 days or last 500 deliveries.

## Run

```bash
npm install
npm run dev
```

The Vite app binds to `0.0.0.0` and defaults to `http://127.0.0.1:5176/` on the Mac or `http://<local-lan-ip>:5176/` from another device on the same network.
The local backend API is available in `server/` and defaults to `http://127.0.0.1:4120/` when run directly:

```bash
WEBHOOKS_PORT=4120 node server/index.mjs
```

## Useful Commands

```bash
npm run lint
npm run build
npm test
npm run test:server
npm run test:e2e
```

## Render

Use one Node Web Service:

```text
Build command: npm ci && npm run build
Start command: npm start
Health check path: /api/health
Node: 24.14.1
```

Recommended environment for the first public review:

```text
NODE_ENV=production
WEBHOOKS_DB_PATH=/tmp/webhooks.sqlite
```

The first Render review uses ephemeral SQLite unless David approves paid persistence. Render restarts, redeploys, or free-service spin-downs can clear rooms, endpoints, queued deliveries, and audit history.

## Local Webhook Example

Create an endpoint in the UI or API, activate it, then post a synthetic local webhook:

```bash
curl -i -X POST 'http://127.0.0.1:4120/hooks/demo-slug/demo-secret' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer fake-token' \
  --data '{"event":"demo","token":"fake-token","email":"demo@example.test"}'
```

Sensitive headers and body keys are redacted in previews. The screenshots and examples use synthetic payloads only and no external requests are performed.

Additional backend curl examples are in `tests/smoke/curl-examples.md`.

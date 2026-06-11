# TASK-0062 Backend Curl Smoke

Synthetic-only examples for the local Webhooks backend. Start the server on loopback:

```bash
WEBHOOKS_PORT=4121 WEBHOOKS_DB_PATH=/tmp/webhooks-task-0062-smoke.sqlite node server/index.mjs
```

Create an endpoint. It defaults to inactive and returns the one-time local receive URL with the generated secret:

```bash
curl -sS -X POST http://127.0.0.1:4121/api/endpoints \
  -H 'content-type: application/json' \
  --data '{"name":"Smoke Hook"}'
```

Inactive receive attempt stores metadata-only blocked delivery. Body is not retained:

```bash
curl -i -X POST 'http://127.0.0.1:4121/hooks/<slug>/<secret>' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer synthetic-secret' \
  --data '{"event":"inactive","token":"synthetic-token"}'
```

Expected: `403`, response status `blocked`, delivery `bodyStorageKind=metadata_only`.

Activate endpoint:

```bash
curl -sS -X POST http://127.0.0.1:4121/api/endpoints/<endpoint-id>/activate
```

Auth failure stores metadata-only blocked delivery and does not retain the body:

```bash
curl -i -X POST 'http://127.0.0.1:4121/hooks/<slug>/wrong-secret' \
  -H 'content-type: text/plain' \
  --data 'token=should-not-store'
```

Expected: `403`, response status `blocked`, latest error `auth_failed`.

Active JSON payload queues with redacted preview:

```bash
curl -i -X POST 'http://127.0.0.1:4121/hooks/<slug>/<secret>' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer synthetic-secret' \
  --data '{"event":"queued","token":"synthetic-token","email":"demo@example.test"}'
```

Expected: `202`, response status `queued`; delivery preview redacts `token` and `email`.

Active form payload queues with redacted preview:

```bash
curl -i -X POST 'http://127.0.0.1:4121/hooks/<slug>/<secret>' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'event=form&secret=synthetic-form-secret'
```

Release only selected queued deliveries in simulated mode:

```bash
curl -sS -X POST http://127.0.0.1:4121/api/deliveries/release \
  -H 'content-type: application/json' \
  --data '{"deliveryIds":["<selected-delivery-id>"],"mode":"simulated"}'
```

Expected: selected queued ids move to `released`; unselected queued ids remain `queued`; no outbound HTTP request is sent.

Oversized and unsupported payload checks:

```bash
python3 - <<'PY' | curl -i -X POST 'http://127.0.0.1:4121/hooks/<slug>/<secret>' \
  -H 'content-type: text/plain' \
  --data-binary @-
print("x" * (1024 * 1024 + 1))
PY

curl -i -X POST 'http://127.0.0.1:4121/hooks/<slug>/<secret>' \
  -H 'content-type: application/octet-stream' \
  --data-binary 'synthetic-binary'
```

Expected: oversized returns `413`; unsupported returns `415`; neither stores a request body.

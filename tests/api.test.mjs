import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureDatabase } from '../server/db.mjs';
import { HOST, createApp } from '../server/index.mjs';

function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'webhooks-test-'));
  const db = ensureDatabase(path.join(dir, 'test.sqlite'));
  const app = createApp({ db });
  return new Promise((resolve) => {
    app.listen(0, '127.0.0.1', () => {
      const { port } = app.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        db,
        async request(pathname, options = {}) {
          const res = await fetch(`${this.baseUrl}${pathname}`, options);
          const text = await res.text();
          return { status: res.status, body: text ? JSON.parse(text) : null };
        },
        async close() {
          await new Promise((done) => app.close(done));
          db.close();
          rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}

async function withHarness(fn) {
  const harness = await makeHarness();
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

async function createEndpoint(harness, name = 'Demo') {
  const created = await harness.request('/api/endpoints', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(created.status, 201);
  return created.body.endpoint;
}

test('server bind host defaults to 127.0.0.1', () => {
  assert.equal(HOST, '127.0.0.1');
});

test('new endpoints default inactive and inactive receive stores metadata-only blocked delivery', async () => {
  await withHarness(async (harness) => {
    const endpoint = await createEndpoint(harness);
    assert.equal(endpoint.status, 'inactive');

    const res = await fetch(endpoint.receiveUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer fake-secret-token' },
      body: JSON.stringify({ event: 'demo', token: 'raw-token' }),
    });
    assert.equal(res.status, 403);
    const deliveries = await harness.request('/api/deliveries');
    const blocked = deliveries.body.deliveries[0];
    assert.equal(deliveries.body.deliveries.length, 1);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.bodyStorageKind, 'metadata_only');
    assert.match(blocked.bodyPreview, /Blocked/);
    assert.equal(blocked.headers.authorization, '‹redacted›');
  });
});

test('auth failure stores metadata-only blocked delivery without body', async () => {
  await withHarness(async (harness) => {
    const endpoint = await createEndpoint(harness);
    await harness.request(`/api/endpoints/${endpoint.id}/activate`, { method: 'POST' });

    const res = await fetch(`${harness.baseUrl}/hooks/${endpoint.slug}/wrong-secret`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'token=should-not-store',
    });
    assert.equal(res.status, 403);
    const deliveries = await harness.request('/api/deliveries');
    const [delivery] = deliveries.body.deliveries;
    assert.equal(delivery.status, 'blocked');
    assert.equal(delivery.latestError, 'auth_failed');
  });
});

test('active endpoint queues supported JSON text and form payloads with redacted previews', async () => {
  await withHarness(async (harness) => {
    const endpoint = await createEndpoint(harness);
    await harness.request(`/api/endpoints/${endpoint.id}/activate`, { method: 'POST' });

    const requests = [
      ['application/json', JSON.stringify({ event: 'json', token: 'secret-token' })],
      ['text/plain', 'event=text token=abcdefghijklmnopqrstuvwxyz'],
      ['application/x-www-form-urlencoded', 'event=form&email=david@example.test'],
    ];
    for (const [contentType, body] of requests) {
      const res = await fetch(endpoint.receiveUrl, { method: 'POST', headers: { 'content-type': contentType }, body });
      assert.equal(res.status, 202);
    }
    const deliveries = await harness.request('/api/deliveries?status=queued');
    assert.equal(deliveries.body.deliveries.length, 3);
    const payload = JSON.stringify(deliveries.body.deliveries);
    assert.equal(payload.includes('secret-token'), false);
    assert.equal(payload.includes('abcdefghijklmnopqrstuvwxyz'), false);
    assert.equal(payload.includes('david@example.test'), false);
  });
});

test('size and type handling rejects safely without storing unsupported bodies', async () => {
  await withHarness(async (harness) => {
    const endpoint = await createEndpoint(harness);
    await harness.request(`/api/endpoints/${endpoint.id}/activate`, { method: 'POST' });

    const oversized = await fetch(endpoint.receiveUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);

    const unsupported = await fetch(endpoint.receiveUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'secret-binary',
    });
    assert.equal(unsupported.status, 415);

    const deliveries = await harness.request('/api/deliveries');
    assert.deepEqual(deliveries.body.deliveries.map((d) => d.status).sort(), ['blocked', 'oversized']);
    for (const delivery of deliveries.body.deliveries) assert.equal(delivery.bodyStorageKind, 'metadata_only');
  });
});

test('simulated release affects only selected queued deliveries', async () => {
  await withHarness(async (harness) => {
    const endpoint = await createEndpoint(harness);
    await harness.request(`/api/endpoints/${endpoint.id}/activate`, { method: 'POST' });
    for (const n of [1, 2, 3]) {
      const res = await fetch(endpoint.receiveUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: n }),
      });
      assert.equal(res.status, 202);
    }

    const queuedResponse = await harness.request('/api/deliveries?status=queued');
    const queued = queuedResponse.body.deliveries.map((d) => d.id);
    const release = await harness.request('/api/deliveries/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryIds: [queued[0], queued[1]], mode: 'simulated' }),
    });
    assert.equal(release.status, 200);
    assert.deepEqual(release.body.released.sort(), [queued[0], queued[1]].sort());

    assert.equal((await harness.request(`/api/deliveries/${queued[0]}`)).body.delivery.status, 'released');
    assert.equal((await harness.request(`/api/deliveries/${queued[1]}`)).body.delivery.status, 'released');
    assert.equal((await harness.request(`/api/deliveries/${queued[2]}`)).body.delivery.status, 'queued');

    const second = await harness.request('/api/deliveries/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryIds: [queued[0], queued[2]], mode: 'simulated' }),
    });
    assert.deepEqual(second.body.released, [queued[2]]);
    assert.deepEqual(second.body.skipped, [queued[0]]);
  });
});

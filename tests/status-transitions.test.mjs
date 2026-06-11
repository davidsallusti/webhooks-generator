import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureDatabase } from '../server/db.mjs'
import {
  createBlockedDelivery,
  createEndpoint,
  createQueuedDelivery,
  getDelivery,
  listDeliveries,
  releaseDeliveries,
  updateEndpoint,
} from '../server/store.mjs'

async function testDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webhooks-test-'))
  return ensureDatabase(path.join(dir, 'test.sqlite'))
}

test('new endpoints default inactive with generated secret', async () => {
  const db = await testDb()
  const endpoint = createEndpoint(db, { name: 'Demo Hook' })

  assert.equal(endpoint.status, 'inactive')
  assert.equal(endpoint.slug, 'demo-hook')
  assert.equal(typeof endpoint.secret, 'string')
  assert.equal(endpoint.secret.length > 12, true)
})

test('inactive attempts store metadata-only blocked deliveries with no body', async () => {
  const db = await testDb()
  const endpoint = createEndpoint(db, { name: 'Inactive Hook' })
  const blocked = createBlockedDelivery(db, {
    endpoint,
    method: 'POST',
    path: `/hooks/${endpoint.slug}/secret`,
    query: {},
    headers: { authorization: 'Bearer fake-secret-token' },
    contentType: 'application/json',
    sourceIp: 'local',
    reason: 'endpoint_inactive',
  })

  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.bodyStorageKind, 'metadata_only')
  assert.equal(blocked.bodyPreview, 'Blocked: endpoint_inactive')
  const row = db.prepare('SELECT body_text, headers_redacted_json FROM deliveries WHERE id = ?').get(blocked.id)
  assert.equal(row.body_text, null)
  assert.equal(JSON.parse(row.headers_redacted_json).authorization, '‹redacted›')
})

test('active supported payload queues redacted preview and release only selected queued ids', async () => {
  const db = await testDb()
  const endpoint = createEndpoint(db, { name: 'Active Hook' })
  updateEndpoint(db, endpoint.id, { status: 'active' })
  const first = createQueuedDelivery(db, {
    endpoint,
    method: 'POST',
    path: `/hooks/${endpoint.slug}/secret`,
    query: {},
    headers: { 'content-type': 'application/json', authorization: 'Bearer fake-secret-token' },
    contentType: 'application/json',
    bodyText: '{"event":"demo","token":"hidden","safe":"shown"}',
    bodySize: 48,
    sourceIp: 'local',
  })
  const second = createQueuedDelivery(db, {
    endpoint,
    method: 'POST',
    path: `/hooks/${endpoint.slug}/secret`,
    query: {},
    headers: {},
    contentType: 'text/plain',
    bodyText: 'hello',
    bodySize: 5,
    sourceIp: 'local',
  })

  assert.equal(first.status, 'queued')
  assert.equal(first.bodyPreview.includes('hidden'), false)
  const result = releaseDeliveries(db, [first.id])
  assert.deepEqual(result.released, [first.id])
  assert.equal(getDelivery(db, first.id).status, 'released')
  assert.equal(getDelivery(db, second.id).status, 'queued')
})

test('unsupported payloads are blocked metadata-only', async () => {
  const db = await testDb()
  const endpoint = createEndpoint(db, { name: 'Binary Hook' })
  updateEndpoint(db, endpoint.id, { status: 'active' })
  const delivery = createQueuedDelivery(db, {
    endpoint,
    method: 'POST',
    path: `/hooks/${endpoint.slug}/secret`,
    query: {},
    headers: {},
    contentType: 'multipart/form-data',
    bodyText: 'raw multipart body',
    bodySize: 18,
    sourceIp: 'local',
  })

  assert.equal(delivery.status, 'blocked')
  assert.equal(delivery.bodyStorageKind, 'metadata_only')
  assert.equal(listDeliveries(db, { status: 'blocked' }).length, 1)
})

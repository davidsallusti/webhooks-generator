import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { nowIso } from './db.mjs'
import { isSupportedContentType, previewForBody, redactHeaders, safeError } from './redaction.mjs'

export const MAX_BODY_BYTES = 1_048_576

function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('hex')
}

function safeSlug(input) {
  const base = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || `hook-${randomBytes(4).toString('hex')}`
}

function publicEndpoint(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    localUrl: `http://127.0.0.1:${process.env.WEBHOOKS_PORT || 4120}/hooks/${row.slug}/<secret>`,
  }
}

function safeDeliveryPath(path) {
  return String(path || '').replace(/^(\/hooks\/[^/]+)\/[^/?#]+/, '$1/<secret>')
}

function deliveryView(row) {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    endpointId: row.webhook_id,
    method: row.method,
    path: safeDeliveryPath(row.path),
    query: JSON.parse(row.query_json || '{}'),
    headers: JSON.parse(row.headers_redacted_json || '{}'),
    contentType: row.content_type,
    bodySize: row.body_size,
    bodySha256: row.body_sha256,
    bodyPreview: row.body_preview,
    bodyStorageKind: row.body_storage_kind,
    receivedAt: row.received_at,
    sourceIp: row.source_ip,
    status: row.status,
    latestError: row.latest_error,
    releasedAt: row.released_at,
    blockReason: row.block_reason,
  }
}

export function listEndpoints(db) {
  const rows = db.prepare(`
    SELECT e.*,
      SUM(CASE WHEN d.status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
      SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      MAX(d.received_at) AS last_received_at
    FROM webhook_endpoints e
    LEFT JOIN deliveries d ON d.webhook_id = e.id
    WHERE e.status != 'archived'
    GROUP BY e.id
    ORDER BY e.created_at DESC
  `).all()
  return rows.map((row) => ({
    ...publicEndpoint(row),
    queuedCount: row.queued_count || 0,
    failedCount: row.failed_count || 0,
    lastReceivedAt: row.last_received_at || null,
  }))
}

export function createEndpoint(db, { name, slug }) {
  const created = nowIso()
  const id = randomUUID()
  const secret = randomBytes(18).toString('base64url')
  const finalSlug = safeSlug(slug || name)
  db.prepare(`
    INSERT INTO webhook_endpoints (id, name, slug, secret_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'inactive', ?, ?)
  `).run(id, String(name || 'Untitled webhook').slice(0, 80), finalSlug, hashSecret(secret), created, created)
  addAudit(db, 'endpoint_created', 'endpoint', id, `Endpoint created inactive: ${finalSlug}`)
  return { ...publicEndpoint(db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id)), secret }
}

export function updateEndpoint(db, id, patch) {
  const current = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id)
  if (!current) return null
  const name = patch.name ? String(patch.name).slice(0, 80) : current.name
  const status = ['active', 'inactive'].includes(patch.status) ? patch.status : current.status
  const updated = nowIso()
  db.prepare('UPDATE webhook_endpoints SET name = ?, status = ?, updated_at = ? WHERE id = ?').run(name, status, updated, id)
  if (status !== current.status) addAudit(db, `endpoint_${status}`, 'endpoint', id, `Endpoint ${status}`)
  return publicEndpoint(db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id))
}

export function archiveEndpoint(db, id) {
  const at = nowIso()
  db.prepare("UPDATE webhook_endpoints SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(at, at, id)
  addAudit(db, 'endpoint_archived', 'endpoint', id, 'Endpoint archived')
  return { ok: true }
}

export function findEndpointBySlug(db, slug) {
  return db.prepare('SELECT * FROM webhook_endpoints WHERE slug = ? AND status != ?').get(slug, 'archived')
}

export function verifySecret(endpoint, secret) {
  const expected = Buffer.from(endpoint.secret_hash, 'hex')
  const actual = Buffer.from(hashSecret(secret), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function createBlockedDelivery(db, { endpoint = null, method, path, query, headers, contentType, sourceIp, reason }) {
  const id = randomUUID()
  const received = nowIso()
  db.prepare(`
    INSERT INTO deliveries (
      id, webhook_id, method, path, query_json, headers_redacted_json, content_type, body_size,
      body_sha256, body_preview, body_text, body_storage_kind, received_at, source_ip, status, latest_error, block_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, 'metadata_only', ?, ?, 'blocked', ?, ?)
  `).run(
    id,
    endpoint?.id || null,
    method,
    path,
    JSON.stringify(query || {}),
    JSON.stringify(redactHeaders(headers)),
    contentType || '',
    `Blocked: ${reason}`,
    received,
    sourceIp || 'local',
    safeError(reason),
    reason,
  )
  addAudit(db, 'delivery_blocked', 'delivery', id, `Delivery blocked: ${reason}`)
  return deliveryView(db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id))
}

export function createQueuedDelivery(db, { endpoint, method, path, query, headers, contentType, bodyText, bodySize, sourceIp }) {
  const id = randomUUID()
  const received = nowIso()
  const supported = isSupportedContentType(contentType)
  const tooLarge = bodySize > MAX_BODY_BYTES
  const status = supported && !tooLarge ? 'queued' : tooLarge ? 'oversized' : 'blocked'
  const reason = tooLarge ? 'payload_too_large' : supported ? null : 'unsupported_content_type'
  const preview = status === 'queued'
    ? previewForBody({ contentType, text: bodyText })
    : `Blocked: ${reason}; content-type=${contentType || 'unknown'}; size=${bodySize}`
  const bodySha = status === 'queued' ? createHash('sha256').update(bodyText).digest('hex') : null
  db.prepare(`
    INSERT INTO deliveries (
      id, webhook_id, method, path, query_json, headers_redacted_json, content_type, body_size,
      body_sha256, body_preview, body_text, body_storage_kind, received_at, source_ip, status, latest_error, block_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    endpoint.id,
    method,
    path,
    JSON.stringify(query || {}),
    JSON.stringify(redactHeaders(headers)),
    contentType || '',
    bodySize,
    bodySha,
    preview,
    status === 'queued' ? bodyText : null,
    status === 'queued' ? 'inline' : 'metadata_only',
    received,
    sourceIp || 'local',
    status,
    reason,
    reason,
  )
  addAudit(db, status === 'queued' ? 'delivery_queued' : 'delivery_blocked', 'delivery', id, status === 'queued' ? 'Delivery queued' : `Delivery blocked: ${reason}`)
  enforceRetention(db)
  return deliveryView(db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id))
}

export function listDeliveries(db, { webhookId, status } = {}) {
  const clauses = ['archived_at IS NULL']
  const args = []
  if (webhookId) {
    clauses.push('webhook_id = ?')
    args.push(webhookId)
  }
  if (status && status !== 'all') {
    clauses.push('status = ?')
    args.push(status)
  }
  return db.prepare(`SELECT * FROM deliveries WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC LIMIT 500`).all(...args).map(deliveryView)
}

export function getDelivery(db, id) {
  const row = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id)
  return row ? deliveryView(row) : null
}

export function releaseDeliveries(db, deliveryIds = []) {
  const batchId = randomUUID()
  const started = nowIso()
  const released = []
  const skipped = []
  const ids = [...new Set(deliveryIds)]
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id)
      if (!row || row.status !== 'queued') {
        skipped.push(id)
        continue
      }
      db.prepare("UPDATE deliveries SET status = 'released', released_at = ?, latest_error = NULL WHERE id = ?").run(started, id)
      db.prepare(`
        INSERT INTO release_attempts (id, delivery_id, batch_id, mode, destination_label, started_at, finished_at, result, error_summary)
        VALUES (?, ?, ?, 'simulated', 'simulated', ?, ?, 'success', NULL)
      `).run(randomUUID(), id, batchId, started, started)
      addAudit(db, 'delivery_released', 'delivery', id, 'Delivery released in simulated mode')
      released.push(id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { mode: 'simulated', batchId, released, skipped }
}

export function listAudit(db) {
  return db.prepare('SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT 200').all().map((row) => ({
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    targetType: row.target_type,
    targetId: row.target_id,
    timestamp: row.timestamp,
    summary: row.summary,
  }))
}

export function addAudit(db, eventType, targetType, targetId, summary) {
  db.prepare(`
    INSERT INTO audit_events (id, event_type, actor, target_type, target_id, timestamp, summary)
    VALUES (?, ?, 'local-user', ?, ?, ?, ?)
  `).run(randomUUID(), eventType, targetType, targetId, nowIso(), safeError(summary))
}

export function enforceRetention(db) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  db.prepare("UPDATE deliveries SET body_text = NULL, body_storage_kind = 'metadata_only' WHERE body_text IS NOT NULL AND received_at < ?").run(cutoff)
  db.prepare(`
    UPDATE deliveries
    SET body_text = NULL, body_storage_kind = 'metadata_only'
    WHERE body_text IS NOT NULL
      AND id NOT IN (
        SELECT id FROM deliveries WHERE body_text IS NOT NULL ORDER BY received_at DESC LIMIT 500
      )
  `).run()
}

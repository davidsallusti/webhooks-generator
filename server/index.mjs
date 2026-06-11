import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { URL, pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { ensureDatabase } from './db.mjs'
import {
  MAX_BODY_BYTES,
  archiveEndpoint,
  createBlockedDelivery,
  createEndpoint,
  createQueuedDelivery,
  findEndpointBySlug,
  getDelivery,
  listAudit,
  listDeliveries,
  listEndpoints,
  releaseDeliveries,
  updateEndpoint,
  verifySecret,
} from './store.mjs'
import { safeError } from './redaction.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isProduction = process.env.NODE_ENV === 'production'

export const HOST = process.env.WEBHOOKS_HOST || (isProduction ? '0.0.0.0' : '127.0.0.1')
export const PORT = Number(process.env.PORT || process.env.WEBHOOKS_PORT || 4120)
const publicOrigin = normalizeOrigin(process.env.WEBHOOKS_PUBLIC_ORIGIN)

if (!isProduction && HOST !== '127.0.0.1' && HOST !== 'localhost') {
  throw new Error('WEBHOOKS_HOST must remain loopback-only for TASK-0062 MVP')
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString('utf8')
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new Error('request body too large')
  }
  return raw ? JSON.parse(raw) : {}
}

function normalizeOrigin(value) {
  if (!value) return ''
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

function requestProtocol(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  if (isProduction && forwarded) return forwarded
  return req.socket.encrypted ? 'https' : 'http'
}

function requestOrigin(req) {
  return normalizeOrigin(`${requestProtocol(req)}://${req.headers.host || `${HOST}:${PORT}`}`)
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) return { oversized: true, size, text: '' }
    chunks.push(chunk)
  }
  return { oversized: false, size, text: Buffer.concat(chunks).toString('utf8') }
}

function localOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (isProduction) {
    const normalized = normalizeOrigin(origin)
    const allowed = publicOrigin || requestOrigin(req)
    return Boolean(normalized && allowed && normalized === allowed)
  }
  try {
    const parsed = new URL(origin)
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  } catch {
    return false
  }
}

function partsFor(url) {
  return url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
}

function receiveUrl(req, endpoint) {
  return `${requestProtocol(req)}://${req.headers.host || `${HOST}:${PORT}`}/hooks/${endpoint.slug}/${endpoint.secret || '<secret>'}`
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('permissions-policy', 'geolocation=(), payment=()')
  if (isProduction) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
  }
}

async function handleEndpoints(req, res, db, parts) {
  if (req.method === 'GET' && parts.length === 1) {
    json(res, 200, { endpoints: listEndpoints(db) })
    return true
  }
  if (req.method === 'POST' && parts.length === 1) {
    const body = await readJson(req)
    const endpoint = createEndpoint(db, { name: body.name, slug: body.slug })
    json(res, 201, { endpoint: { ...endpoint, receiveUrl: receiveUrl(req, endpoint) } })
    return true
  }
  const id = parts[1]
  if (!id) return false
  if (req.method === 'PATCH' && parts.length === 2) {
    const body = await readJson(req)
    const endpoint = updateEndpoint(db, id, body)
    if (!endpoint) return json(res, 404, { error: 'endpoint not found' }) || true
    json(res, 200, { endpoint })
    return true
  }
  if (req.method === 'POST' && parts[2] === 'archive') {
    json(res, 200, archiveEndpoint(db, id))
    return true
  }
  if (req.method === 'POST' && (parts[2] === 'activate' || parts[2] === 'deactivate')) {
    const endpoint = updateEndpoint(db, id, { status: parts[2] === 'activate' ? 'active' : 'inactive' })
    if (!endpoint) return json(res, 404, { error: 'endpoint not found' }) || true
    json(res, 200, { endpoint })
    return true
  }
  return false
}

async function handleDeliveries(req, res, db, url, parts) {
  if (req.method === 'GET' && parts.length === 1) {
    json(res, 200, {
      deliveries: listDeliveries(db, {
        webhookId: url.searchParams.get('webhookId') || url.searchParams.get('endpointId') || undefined,
        status: url.searchParams.get('status') || undefined,
      }),
    })
    return true
  }
  if (req.method === 'GET' && parts.length === 2) {
    const delivery = getDelivery(db, parts[1])
    if (!delivery) return json(res, 404, { error: 'delivery not found' }) || true
    json(res, 200, { delivery })
    return true
  }
  if (req.method === 'POST' && parts[1] === 'release') {
    const body = await readJson(req)
    if (body.mode && body.mode !== 'simulated') throw new Error('only simulated release is enabled')
    json(res, 200, releaseDeliveries(db, body.deliveryIds || []))
    return true
  }
  return false
}

async function handleHook(req, res, db, url, parts) {
  if (req.method !== 'POST' || parts[0] !== 'hooks' || parts.length !== 3) return false
  const [, slug, secret] = parts
  const endpoint = findEndpointBySlug(db, slug)
  const base = {
    endpoint,
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: req.headers,
    contentType: req.headers['content-type'] || '',
    sourceIp: 'local',
  }

  if (!endpoint || !verifySecret(endpoint, secret)) {
    createBlockedDelivery(db, { ...base, endpoint, reason: endpoint ? 'auth_failed' : 'unknown_endpoint' })
    json(res, endpoint ? 403 : 404, { ok: false, status: 'blocked' })
    return true
  }
  if (endpoint.status !== 'active') {
    createBlockedDelivery(db, { ...base, reason: `endpoint_${endpoint.status}` })
    json(res, endpoint.status === 'archived' ? 410 : 403, { ok: false, status: 'blocked', reason: endpoint.status })
    return true
  }

  const body = await readBody(req)
  const delivery = createQueuedDelivery(db, {
    ...base,
    bodyText: body.text,
    bodySize: body.oversized ? body.size : Buffer.byteLength(body.text, 'utf8'),
  })
  if (delivery.blockReason === 'payload_too_large') {
    json(res, 413, { ok: false, status: delivery.status, deliveryId: delivery.id })
    return true
  }
  if (delivery.blockReason === 'unsupported_content_type') {
    json(res, 415, { ok: false, status: delivery.status, deliveryId: delivery.id })
    return true
  }
  json(res, 202, { ok: true, status: 'queued', deliveryId: delivery.id })
  return true
}

export function createApp({ db = ensureDatabase() } = {}) {
  return createServer(async (req, res) => {
    securityHeaders(res)
    if (!localOrigin(req)) return json(res, 403, { error: 'forbidden origin' })
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`)
    const parts = partsFor(url)
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, { ok: true, host: HOST, mode: isProduction ? 'render-public-review' : 'local-only' })
      }
      if (parts[0] === 'api' && parts[1] === 'endpoints' && (await handleEndpoints(req, res, db, parts.slice(1)))) return
      if (parts[0] === 'api' && parts[1] === 'deliveries' && (await handleDeliveries(req, res, db, url, parts.slice(1)))) return
      if (parts[0] === 'api' && parts[1] === 'audit' && req.method === 'GET') return json(res, 200, { audit: listAudit(db) })
      if (await handleHook(req, res, db, url, parts)) return
      if (isProduction && req.method === 'GET' && await serveStatic(res, url.pathname)) return
      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, /invalid|required|only/.test(err.message) ? 400 : 500, { error: safeError(err.message) })
    }
  })
}

async function serveStatic(res, pathname) {
  const distDir = path.resolve(__dirname, '..', 'dist')
  const safePath = pathname === '/' ? '/index.html' : pathname
  const requested = path.resolve(distDir, `.${safePath}`)
  const filePath = requested.startsWith(distDir) && existsSync(requested) && statSync(requested).isFile()
    ? requested
    : path.join(distDir, 'index.html')
  if (!existsSync(filePath)) return false
  res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' })
  createReadStream(filePath).pipe(res)
  return true
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

export function listen({ host = HOST, port = PORT, db = ensureDatabase() } = {}) {
  const app = createApp({ db })
  return new Promise((resolve) => app.listen(port, host, () => resolve(app)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await listen()
  const addr = app.address()
  console.log(`Webhooks server listening on http://${addr.address}:${addr.port}`)
  console.log(`${isProduction ? 'Public review' : 'Local-only MVP'}: simulated release only; no outbound sends are enabled.`)
}

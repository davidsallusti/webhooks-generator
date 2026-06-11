import { createHash } from 'node:crypto'

const REDACTED = '‹redacted›'

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'api-key',
  'apikey',
  'access-token',
  'id-token',
  'refresh-token',
  'client-secret',
  'webhook-secret',
  'x-hub-signature',
  'x-hub-signature-256',
  'stripe-signature',
  'svix-signature',
  'signature',
])

const SENSITIVE_KEY_RE = /(password|passcode|pin|secret|client_secret|webhook_secret|token|access_token|refresh_token|id_token|api_?key|authorization|auth|cookie|set_cookie|session|session_id|signature|sig|hmac|private_key|email|phone|address|ssn|dob|card|iban)/i

const TOKEN_RE = /\b(?:Bearer\s+\S+|(?:api[_-]?key|token|secret|signature)(?:\s*[:=]\s*|\s+)[A-Za-z0-9._~+/=-]{6,}|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{8,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{24,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+?\d[\d .()-]{7,}\d)\b/gi

export function redactHeaders(headers = {}) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase()
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    out[normalized] = SENSITIVE_HEADERS.has(normalized) ? REDACTED : redactText(text).slice(0, 500)
  }
  return out
}

export function redactText(value) {
  return String(value ?? '').replace(TOKEN_RE, REDACTED)
}

export function redactJson(value) {
  if (Array.isArray(value)) return value.map((item) => redactJson(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY_RE.test(key) ? REDACTED : redactJson(child),
      ]),
    )
  }
  if (typeof value === 'string') return redactText(value)
  return value
}

export function previewForBody({ contentType, text, max = 16 * 1024 }) {
  const source = String(text ?? '')
  const type = String(contentType || '').toLowerCase()
  if (type.includes('application/json')) {
    try {
      return JSON.stringify(redactJson(JSON.parse(source)), null, 2).slice(0, max)
    } catch {
      return redactText(source).slice(0, max)
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(source)
    const out = {}
    for (const [key, value] of params.entries()) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactText(value)
    }
    return JSON.stringify(out, null, 2).slice(0, max)
  }
  return redactText(source).slice(0, max)
}

export function isSupportedContentType(contentType = '') {
  const type = contentType.toLowerCase()
  return (
    type.includes('application/json') ||
    type.includes('text/') ||
    type.includes('application/x-www-form-urlencoded') ||
    type === ''
  )
}

export function safeError(value) {
  return redactText(value).replace(/\/Users\/[^\s]+/g, '‹redacted-path›').slice(0, 500)
}

export function digest(value) {
  return createHash('sha256').update(value || '').digest('hex')
}

export function redactObject(value) {
  return redactJson(value)
}

export function previewJson(value) {
  return JSON.stringify(redactJson(value), null, 2).slice(0, 16 * 1024)
}

export function truncatePreview(value) {
  return redactText(value).slice(0, 16 * 1024)
}

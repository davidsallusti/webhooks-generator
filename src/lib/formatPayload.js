const sensitiveKeyRe = /(authorization|cookie|token|secret|signature|password|api[-_]?key|email|phone|address|session|card|ssn)/i
const tokenLikeRe = /(bearer\s+)[a-z0-9._-]+|(?:api[-_]?key|token|secret|signature)(?:\s*[:=]\s*|\s+)[a-z0-9._~+/=-]{6,}|([a-z0-9]{12,}\.[a-z0-9._-]+)|([a-z0-9_-]{24,})|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\+?\d[\d .()-]{7,}\d/gi

export const REDACTED = '<redacted>'

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export function formatTime(iso) {
  if (!iso) return 'Never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function redactScalar(value) {
  if (value == null) return value
  return String(value).replace(tokenLikeRe, (_match, bearer) => (bearer ? `${bearer}${REDACTED}` : REDACTED))
}

export function redactObject(value, key = '') {
  if (sensitiveKeyRe.test(key)) return REDACTED
  if (Array.isArray(value)) return value.map((item) => redactObject(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactObject(childValue, childKey)]))
  }
  return typeof value === 'string' ? redactScalar(value) : value
}

export function payloadPreview(delivery) {
  if (delivery?.bodyPreview && !delivery?.bodyPayload) return redactScalar(delivery.bodyPreview)
  const payload = delivery?.bodyPayload ?? delivery?.payload
  if (!payload) {
    if (delivery?.status === 'blocked') return 'Metadata-only blocked attempt. Body was not retained.'
    if (delivery?.status === 'oversized') return 'Payload exceeded the local 1 MB cap. Body preview was not retained.'
    return 'No payload preview available.'
  }
  let source = payload
  if (typeof source === 'string' && delivery?.contentType?.includes('application/json')) {
    try {
      source = JSON.parse(source)
    } catch {
      source = payload
    }
  }
  const redacted = redactObject(source)
  const pretty = typeof redacted === 'string' ? redactScalar(redacted) : JSON.stringify(redacted, null, 2)
  return pretty.length > 12000 ? `${pretty.slice(0, 12000)}\n... truncated preview ...` : pretty
}

export function redactedHeaders(headers = {}) {
  return redactObject(headers)
}

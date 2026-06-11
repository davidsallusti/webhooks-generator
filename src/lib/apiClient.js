const JSON_HEADERS = { 'content-type': 'application/json' }

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`)
  return data
}

export async function getHealth() {
  return parseResponse(await fetch('/api/health'))
}

export async function listEndpoints() {
  const data = await parseResponse(await fetch('/api/endpoints'))
  return data.endpoints || []
}

export async function createEndpoint(name) {
  return parseResponse(await fetch('/api/endpoints', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  }))
}

export async function updateEndpoint(id, patch) {
  const data = await parseResponse(await fetch(`/api/endpoints/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }))
  return data.endpoint
}

export async function archiveEndpoint(id) {
  const data = await parseResponse(await fetch(`/api/endpoints/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  }))
  return data.endpoint
}

export async function listDeliveries({ endpointId, status, limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (endpointId) params.set('endpointId', endpointId)
  if (status && status !== 'all') params.set('status', status)
  const data = await parseResponse(await fetch(`/api/deliveries?${params}`))
  return data.deliveries || []
}

export async function getDelivery(id) {
  const data = await parseResponse(await fetch(`/api/deliveries/${encodeURIComponent(id)}?includePayload=1`))
  return data.delivery
}

export async function releaseDeliveries(deliveryIds) {
  return parseResponse(await fetch('/api/deliveries/release', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ mode: 'simulated', deliveryIds }),
  }))
}

export async function listAudit() {
  const data = await parseResponse(await fetch('/api/audit'))
  return data.audit || []
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  archiveEndpoint,
  createEndpoint,
  getDelivery,
  getHealth,
  listAudit,
  listDeliveries,
  listEndpoints,
  releaseDeliveries,
  updateEndpoint,
} from './lib/apiClient.js'
import { formatBytes, formatTime, payloadPreview, redactedHeaders } from './lib/formatPayload.js'
import { deliveryStatuses, isReleasable, statusTone, summarizeQueue } from './lib/statusModel.js'

function App() {
  const [health, setHealth] = useState(null)
  const [endpoints, setEndpoints] = useState([])
  const [deliveries, setDeliveries] = useState([])
  const [audit, setAudit] = useState([])
  const [selectedEndpointId, setSelectedEndpointId] = useState('')
  const [selectedDeliveryIds, setSelectedDeliveryIds] = useState(new Set())
  const [focusedDelivery, setFocusedDelivery] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [newEndpointName, setNewEndpointName] = useState('')
  const [editingEndpointId, setEditingEndpointId] = useState('')
  const [editEndpointName, setEditEndpointName] = useState('')
  const [lastSecret, setLastSecret] = useState(null)
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const endpointById = useMemo(() => new Map(endpoints.map((endpoint) => [endpoint.id, endpoint])), [endpoints])
  const selectedEndpoint = endpointById.get(selectedEndpointId) || endpoints[0] || null

  const refresh = useCallback(async ({ keepFocus = true } = {}) => {
    setError('')
    const [healthData, endpointItems, deliveryItems, auditItems] = await Promise.all([
      getHealth(),
      listEndpoints(),
      listDeliveries({ limit: 300 }),
      listAudit(),
    ])
    setHealth(healthData)
    setEndpoints(endpointItems)
    setDeliveries(deliveryItems)
    setAudit(auditItems)
    if (!selectedEndpointId && endpointItems[0]) setSelectedEndpointId(endpointItems[0].id)
    if (!keepFocus) setFocusedDelivery(null)
  }, [selectedEndpointId])

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [refresh])

  const scopedDeliveries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return deliveries
      .filter((delivery) => !selectedEndpoint || delivery.endpointId === selectedEndpoint.id || delivery.webhookId === selectedEndpoint.id)
      .filter((delivery) => statusFilter === 'all' || delivery.status === statusFilter)
      .filter((delivery) => {
        if (!normalizedQuery) return true
        const endpoint = endpointById.get(delivery.endpointId || delivery.webhookId)
        return [
          delivery.id,
          delivery.method,
          delivery.path,
          delivery.status,
          endpoint?.name,
          delivery.contentType,
          delivery.latestError,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery)
      })
  }, [deliveries, endpointById, query, selectedEndpoint, statusFilter])

  const focused = focusedDelivery || scopedDeliveries[0] || null
  const selectedDeliveries = deliveries.filter((delivery) => selectedDeliveryIds.has(delivery.id))
  const releasableSelected = selectedDeliveries.filter(isReleasable)
  const queueSummary = summarizeQueue(deliveries.filter((delivery) => (
    !selectedEndpoint || delivery.endpointId === selectedEndpoint.id || delivery.webhookId === selectedEndpoint.id
  )))
  const globalQueueSummary = summarizeQueue(deliveries)
  const visibleReleasableIds = scopedDeliveries.filter(isReleasable).map((delivery) => delivery.id)
  const allVisibleReleasableSelected =
    visibleReleasableIds.length > 0 && visibleReleasableIds.every((id) => selectedDeliveryIds.has(id))
  const activeEndpointCount = endpoints.filter((endpoint) => endpoint.status === 'active').length
  const archivedEndpointCount = endpoints.filter((endpoint) => endpoint.status === 'archived').length
  const latestDeliveryAt = deliveries[0]?.receivedAt || null

  async function handleCreateEndpoint(event) {
    event.preventDefault()
    const name = newEndpointName.trim()
    if (!name) return
    setError('')
    const result = await createEndpoint(name)
    setLastSecret({
      endpointId: result.endpoint.id,
      endpointName: result.endpoint.name,
      secret: result.endpoint.secret,
      receiveUrl: result.endpoint.receiveUrl,
    })
    setNewEndpointName('')
    await refresh()
    setSelectedEndpointId(result.endpoint.id)
    setFocusedDelivery(null)
  }

  async function handleStatusToggle(endpoint, status) {
    setEndpoints((items) => items.map((item) => (item.id === endpoint.id ? { ...item, status } : item)))
    await updateEndpoint(endpoint.id, { status })
    await refresh()
  }

  async function handleEditEndpoint(event) {
    event.preventDefault()
    const name = editEndpointName.trim()
    if (!editingEndpointId || !name) return
    setEndpoints((items) => items.map((item) => (item.id === editingEndpointId ? { ...item, name } : item)))
    await updateEndpoint(editingEndpointId, { name })
    setEditingEndpointId('')
    setEditEndpointName('')
    await refresh()
  }

  function startEndpointEdit(endpoint) {
    setEditingEndpointId(endpoint.id)
    setEditEndpointName(endpoint.name)
  }

  async function handleArchive(endpoint) {
    await archiveEndpoint(endpoint.id)
    setEditingEndpointId('')
    setEditEndpointName('')
    setSelectedEndpointId('')
    await refresh({ keepFocus: false })
  }

  async function focusDelivery(delivery) {
    setError('')
    try {
      setFocusedDelivery(await getDelivery(delivery.id))
    } catch (err) {
      setError(err.message)
      setFocusedDelivery(delivery)
    }
  }

  function toggleDeliverySelection(delivery) {
    if (!isReleasable(delivery)) return
    setSelectedDeliveryIds((current) => {
      const next = new Set(current)
      if (next.has(delivery.id)) next.delete(delivery.id)
      else next.add(delivery.id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelectedDeliveryIds((current) => {
      const next = new Set(current)
      if (allVisibleReleasableSelected) visibleReleasableIds.forEach((id) => next.delete(id))
      else visibleReleasableIds.forEach((id) => next.add(id))
      return next
    })
  }

  async function handleReleaseSelected() {
    const ids = releasableSelected.map((delivery) => delivery.id)
    if (!ids.length) return
    await releaseDeliveries(ids)
    setSelectedDeliveryIds(new Set())
    setReleaseConfirmOpen(false)
    await refresh()
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">WH</span>
          <div>
            <span className="brand-kicker">Operations Console</span>
            <strong>Webhooks Control Surface</strong>
            <span>Local intake queue with redacted inspection and simulated release controls</span>
          </div>
        </div>
        <div className="topbar-side">
          <div className="topbar-meta">
            <span>Host</span>
            <strong>{health?.host || '127.0.0.1'}</strong>
          </div>
          <div className="boundary-pill" role="status">
            Local only · simulated release · no outbound sends
          </div>
        </div>
      </header>

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

      <main className="page-shell">
        <section className="hero-panel" aria-label="Console summary">
          <div className="hero-copy">
            <span className="eyebrow">Queue governance</span>
            <h1>Polished oversight for inbound webhook traffic.</h1>
            <p>
              Create endpoints, keep intake constrained to local environments, review redacted payloads,
              and release queued deliveries only when they are ready for controlled progression.
            </p>
          </div>
          <div className="hero-metrics" aria-label="Operational metrics">
            <MetricCard label="Endpoints" value={String(endpoints.length)} detail={`${activeEndpointCount} active · ${archivedEndpointCount} archived`} />
            <MetricCard label="Queued now" value={String(globalQueueSummary.queued)} detail={`${globalQueueSummary.releasable} releasable`} />
            <MetricCard label="Released" value={String(globalQueueSummary.released)} detail={`${globalQueueSummary.blocked} blocked`} />
            <MetricCard label="Latest intake" value={latestDeliveryAt ? formatTime(latestDeliveryAt) : 'No traffic'} detail="most recent captured delivery" />
          </div>
        </section>

        <section className="workbench">
        <aside className="endpoint-panel" aria-label="Webhook endpoints">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Registry</span>
              <h2>Endpoints</h2>
              <p>{loading ? 'Loading local state' : `${endpoints.length} controlled intake surfaces`}</p>
            </div>
          </div>

          <form className="endpoint-form" onSubmit={handleCreateEndpoint}>
            <label>
              New endpoint
              <input
                value={newEndpointName}
                onChange={(event) => setNewEndpointName(event.target.value)}
                placeholder="Release intake"
              />
            </label>
            <button type="submit" className="primary" disabled={!newEndpointName.trim()}>
              Create endpoint
            </button>
          </form>

          {lastSecret ? (
            <section className="secret-card" aria-label="New endpoint secret">
              <div className="section-row">
                <h2>Secret shown once</h2>
                <button type="button" onClick={() => setLastSecret(null)}>Dismiss</button>
              </div>
              <p>{lastSecret.endpointName}</p>
              <code>{lastSecret.receiveUrl}</code>
            </section>
          ) : null}

          <div className="endpoint-list">
            {endpoints.length === 0 ? (
              <p className="empty-note">Create a local endpoint to receive simulated Release webhook payloads.</p>
            ) : endpoints.map((endpoint) => {
              const endpointDeliveries = deliveries.filter((delivery) => delivery.endpointId === endpoint.id || delivery.webhookId === endpoint.id)
              const summary = summarizeQueue(endpointDeliveries)
              return (
                <button
                  type="button"
                  className={`endpoint-card${endpoint.id === selectedEndpoint?.id ? ' active' : ''}`}
                  key={endpoint.id}
                  onClick={() => {
                    setSelectedEndpointId(endpoint.id)
                    setFocusedDelivery(null)
                  }}
                >
                  <span className={`state-dot ${endpoint.status}`} aria-hidden="true" />
                  <span className="endpoint-main">
                    <span className="endpoint-title-row">
                      <strong>{endpoint.name}</strong>
                      <span className={`inline-state inline-state-${endpoint.status}`}>{endpoint.status}</span>
                    </span>
                    <small>/hooks/{endpoint.slug}/&lt;secret&gt;</small>
                    <em>{summary.queued} queued · {summary.blocked} blocked · {summary.released} released</em>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="queue-panel" aria-label="Webhook delivery queue">
          <section className="endpoint-toolbar">
            <div>
              <span className="eyebrow">Delivery queue</span>
              <h2>{selectedEndpoint?.name || 'No endpoint selected'}</h2>
              <p>
                {selectedEndpoint
                  ? `New endpoints are inactive by default. Activate only for local test captures and controlled intake windows.`
                  : 'Create an endpoint to begin local captures.'}
              </p>
            </div>
            {selectedEndpoint ? (
              <div className="toolbar-actions">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={selectedEndpoint.status === 'active'}
                    onChange={(event) => handleStatusToggle(selectedEndpoint, event.target.checked ? 'active' : 'inactive')}
                  />
                  <span>{selectedEndpoint.status === 'active' ? 'Active' : 'Inactive'}</span>
                </label>
                <button type="button" onClick={() => startEndpointEdit(selectedEndpoint)}>Rename</button>
                <button type="button" onClick={() => handleArchive(selectedEndpoint)}>Archive</button>
              </div>
            ) : null}
          </section>

          {selectedEndpoint && editingEndpointId === selectedEndpoint.id ? (
            <form className="endpoint-edit-form" onSubmit={handleEditEndpoint}>
              <label>
                Endpoint name
                <input
                  value={editEndpointName}
                  onChange={(event) => setEditEndpointName(event.target.value)}
                  placeholder="Endpoint name"
                />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  onClick={() => {
                    setEditingEndpointId('')
                    setEditEndpointName('')
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={!editEndpointName.trim()}>Save name</button>
              </div>
            </form>
          ) : null}

          <section className="summary-strip" aria-label="Queue summary">
            <span><strong>{queueSummary.total}</strong><small>Total</small></span>
            <span><strong>{queueSummary.queued}</strong><small>Queued</small></span>
            <span><strong>{queueSummary.releasable}</strong><small>Releasable</small></span>
            <span><strong>{queueSummary.blocked}</strong><small>Blocked</small></span>
            <span><strong>{queueSummary.released}</strong><small>Released</small></span>
          </section>

          <section className="queue-controls">
            <div className="status-chips" aria-label="Delivery status filters">
              <button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>All</button>
              {deliveryStatuses.map((status) => (
                <button
                  type="button"
                  key={status.key}
                  className={statusFilter === status.key ? 'active' : ''}
                  onClick={() => setStatusFilter(status.key)}
                >
                  {status.label}
                </button>
              ))}
            </div>
            <label className="search-field">
              <span>Search</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="status, id, method, path" />
            </label>
            <button
              type="button"
              className="release-button"
              disabled={releasableSelected.length === 0}
              onClick={() => setReleaseConfirmOpen(true)}
            >
              Release selected
              <span>{releasableSelected.length}</span>
            </button>
          </section>

          <DeliveryTable
            deliveries={scopedDeliveries}
            endpointById={endpointById}
            focusedId={focused?.id}
            selectedIds={selectedDeliveryIds}
            allVisibleReleasableSelected={allVisibleReleasableSelected}
            visibleReleasableCount={visibleReleasableIds.length}
            onToggleAll={toggleAllVisible}
            onToggle={toggleDeliverySelection}
            onFocus={focusDelivery}
          />
        </section>

        <aside className="detail-panel" aria-label="Delivery detail">
          {focused ? (
            <DeliveryDetail delivery={focused} endpoint={endpointById.get(focused.endpointId || focused.webhookId)} />
          ) : (
            <div className="detail-empty">
              <h2>No delivery selected</h2>
              <p>Receive a local webhook or select a row to inspect redacted metadata.</p>
            </div>
          )}

          <section className="audit-panel">
            <div className="audit-head">
              <div>
                <span className="eyebrow">Governance log</span>
                <h2>Audit history</h2>
              </div>
            </div>
            <ol>
              {audit.length === 0 ? <li><p>No audit events yet.</p></li> : audit.map((event) => (
                <li key={event.id}>
                  <span>{formatTime(event.createdAt || event.timestamp)}</span>
                  <p>{event.summary}</p>
                </li>
              ))}
            </ol>
          </section>
        </aside>
        </section>
      </main>

      {releaseConfirmOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setReleaseConfirmOpen(false)}>
          <section
            className="release-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="release-title">Release selected webhooks?</h2>
            <p>
              This marks {releasableSelected.length} queued delivery{releasableSelected.length === 1 ? '' : 'ies'} as released in simulated mode.
              No destination is configured and no outbound request will be sent.
            </p>
            <div className="modal-summary">
              <span>Mode<strong>Simulated</strong></span>
              <span>Rows<strong>{releasableSelected.length}</strong></span>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setReleaseConfirmOpen(false)}>Cancel</button>
              <button type="button" className="primary" onClick={handleReleaseSelected}>Confirm release</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function DeliveryTable({
  deliveries,
  endpointById,
  focusedId,
  selectedIds,
  allVisibleReleasableSelected,
  visibleReleasableCount,
  onToggleAll,
  onToggle,
  onFocus,
}) {
  return (
    <div className="queue-table-wrap">
      <table className="queue-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all releasable visible deliveries"
                checked={allVisibleReleasableSelected}
                disabled={visibleReleasableCount === 0}
                onChange={onToggleAll}
              />
            </th>
            <th>Delivery</th>
            <th>Status</th>
            <th>Method</th>
            <th>Received</th>
            <th>Size</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.length === 0 ? (
            <tr>
              <td colSpan="7" className="empty-cell">No deliveries match the current filters.</td>
            </tr>
          ) : deliveries.map((delivery) => {
            const endpoint = endpointById.get(delivery.endpointId || delivery.webhookId)
            const selected = selectedIds.has(delivery.id)
            return (
              <tr
                key={delivery.id}
                className={delivery.id === focusedId ? 'focused' : ''}
                onClick={() => onFocus(delivery)}
              >
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${delivery.id}`}
                    checked={selected}
                    disabled={!isReleasable(delivery)}
                    onChange={() => onToggle(delivery)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </td>
                <td>
                  <strong>{delivery.id}</strong>
                  <span>{endpoint?.name || 'Unknown endpoint'}</span>
                  <small>{delivery.path}</small>
                </td>
                <td><StatusChip status={delivery.status} /></td>
                <td>{delivery.method}</td>
                <td>{formatTime(delivery.receivedAt)}</td>
                <td>{formatBytes(delivery.bodySize)}</td>
                <td>{delivery.latestError || (delivery.releasedAt ? 'Simulated release complete' : 'Queued for manual release')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StatusChip({ status }) {
  return <span className={`status-chip tone-${statusTone(status)}`}>{deliveryStatuses.find((item) => item.key === status)?.label || status}</span>
}

function MetricCard({ label, value, detail }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function DeliveryDetail({ delivery, endpoint }) {
  const headers = redactedHeaders(delivery.headers)
  return (
    <section className="delivery-detail">
      <section className="detail-stage">
        <div className="detail-head">
          <div>
            <span className="eyebrow">Delivery detail</span>
            <h2>{delivery.id}</h2>
          </div>
          <StatusChip status={delivery.status} />
        </div>
        <p className="detail-lead">
          Review the captured request before any simulated release. The right rail keeps metadata,
          payload context, and audit history in one aligned inspection surface.
        </p>
        <dl className="meta-grid">
          <div><dt>Endpoint</dt><dd>{endpoint?.name || 'Unknown'}</dd></div>
          <div><dt>Received</dt><dd>{formatTime(delivery.receivedAt)}</dd></div>
          <div><dt>Method</dt><dd>{delivery.method}</dd></div>
          <div><dt>Content type</dt><dd>{delivery.contentType || 'unknown'}</dd></div>
          <div><dt>Storage</dt><dd>{delivery.bodyStorageKind || 'metadata_only'}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(delivery.bodySize)}</dd></div>
        </dl>
      </section>
      <section className="payload-card">
        <div className="section-row">
          <h3>Redacted payload preview</h3>
          <span>safe default</span>
        </div>
        <pre>{payloadPreview(delivery)}</pre>
      </section>
      <section className="payload-card">
        <div className="section-row">
          <h3>Headers</h3>
          <span>case-insensitive redaction</span>
        </div>
        <pre>{JSON.stringify(headers, null, 2)}</pre>
      </section>
      {delivery.latestError ? <p className="error-note">{delivery.latestError}</p> : null}
    </section>
  )
}

export default App

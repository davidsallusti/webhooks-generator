export const deliveryStatuses = [
  { key: 'queued', label: 'Queued', tone: 'blue' },
  { key: 'released', label: 'Released', tone: 'green' },
  { key: 'blocked', label: 'Blocked', tone: 'red' },
  { key: 'failed', label: 'Failed', tone: 'red' },
  { key: 'oversized', label: 'Oversized', tone: 'amber' },
]

export function isReleasable(delivery) {
  return delivery?.status === 'queued' && !delivery?.blocked && !delivery?.oversized
}

export function statusTone(status) {
  return deliveryStatuses.find((item) => item.key === status)?.tone || 'gray'
}

export function summarizeQueue(deliveries) {
  return deliveries.reduce(
    (summary, delivery) => {
      summary.total += 1
      summary[delivery.status] = (summary[delivery.status] || 0) + 1
      if (isReleasable(delivery)) summary.releasable += 1
      return summary
    },
    { total: 0, queued: 0, released: 0, blocked: 0, failed: 0, oversized: 0, releasable: 0 },
  )
}

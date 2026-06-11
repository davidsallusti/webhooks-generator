import { releaseDeliveries as releaseSelected } from './store.mjs'

export function releaseDeliveries(db, { deliveryIds, mode = 'simulated' }) {
  if (mode !== 'simulated') throw new Error('only simulated release is enabled')
  return releaseSelected(db, deliveryIds)
}

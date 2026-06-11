import test from 'node:test'
import assert from 'node:assert/strict'
import { isReleasable, summarizeQueue } from '../src/lib/statusModel.js'
import { payloadPreview, redactedHeaders, REDACTED } from '../src/lib/formatPayload.js'

test('release eligibility is queued-only and excludes blocked or oversized rows', () => {
  assert.equal(isReleasable({ status: 'queued' }), true)
  assert.equal(isReleasable({ status: 'queued', blocked: true }), false)
  assert.equal(isReleasable({ status: 'queued', oversized: true }), false)
  assert.equal(isReleasable({ status: 'released' }), false)
})

test('queue summary counts releasable rows separately from blocked rows', () => {
  const summary = summarizeQueue([
    { status: 'queued' },
    { status: 'queued', blocked: true, blockedReason: 'inactive' },
    { status: 'released' },
  ])
  assert.equal(summary.total, 3)
  assert.equal(summary.queued, 2)
  assert.equal(summary.releasable, 1)
})

test('headers and payload previews redact sensitive values', () => {
  const headers = redactedHeaders({ authorization: 'Bearer synthetic-token', 'content-type': 'application/json' })
  assert.equal(headers.authorization, REDACTED)
  assert.equal(headers['content-type'], 'application/json')
  const preview = payloadPreview({
    payload: { user: { email: 'demo@example.test', token: 'synthetic-token' }, event: 'demo' },
  })
  assert.match(preview, /<redacted>/)
  assert.doesNotMatch(preview, /demo@example.test/)
  assert.doesNotMatch(preview, /synthetic-token/)
})

test('payload preview redacts plain text labeled secret values', () => {
  const preview = payloadPreview({
    contentType: 'text/plain',
    bodyPayload: 'plain token TESS_SECRET_RAW_0062 email tess-secret@example.test',
  })

  assert.match(preview, /<redacted>/)
  assert.doesNotMatch(preview, /TESS_SECRET_RAW_0062/)
  assert.doesNotMatch(preview, /tess-secret@example.test/)
})

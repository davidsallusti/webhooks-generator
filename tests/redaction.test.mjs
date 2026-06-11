import assert from 'node:assert/strict';
import test from 'node:test';
import { previewJson, redactHeaders, redactObject, truncatePreview } from '../server/redaction.mjs';

test('header redaction is case-insensitive', () => {
  const redacted = redactHeaders({
    Authorization: 'Bearer secret-token-value',
    'X-API-Key': 'abc123secret',
    'Content-Type': 'application/json',
  });

  assert.equal(redacted.authorization, '‹redacted›');
  assert.equal(redacted['x-api-key'], '‹redacted›');
  assert.equal(redacted['content-type'], 'application/json');
});

test('JSON body redaction recursively masks sensitive and PII-like keys', () => {
  const redacted = redactObject({
    event: 'demo',
    token: 'secret-token',
    customer: {
      email: 'david@example.test',
      nested: [{ api_key: 'abc123' }],
    },
  });

  assert.equal(redacted.event, 'demo');
  assert.equal(redacted.token, '‹redacted›');
  assert.equal(redacted.customer.email, '‹redacted›');
  assert.equal(redacted.customer.nested[0].api_key, '‹redacted›');
});

test('text token masking and preview truncation work', () => {
  const preview = truncatePreview(`token=abcdefghijklmnopqrstuvwxyz email david@example.test ${'x'.repeat(20_000)}`);

  assert.equal(preview.includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(preview.includes('david@example.test'), false);
  assert.equal(preview.length <= 16 * 1024, true);
});

test('plain text labeled secrets are redacted when separated by whitespace or colon', () => {
  const preview = truncatePreview('plain token TESS_SECRET_RAW_0062 secret: SECOND_SECRET_VALUE signature abcdefghij');

  assert.equal(preview.includes('TESS_SECRET_RAW_0062'), false);
  assert.equal(preview.includes('SECOND_SECRET_VALUE'), false);
  assert.equal(preview.includes('abcdefghij'), false);
  assert.match(preview, /‹redacted›/);
});

test('JSON preview does not include sensitive raw values', () => {
  const preview = previewJson({ secret: 'raw-secret', ok: true });

  assert.equal(preview.includes('raw-secret'), false);
  assert.equal(preview.includes('"ok": true'), true);
});

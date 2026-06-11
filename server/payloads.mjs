import { digest, previewJson, truncatePreview } from './redaction.mjs';

export const MAX_BODY_BYTES = 1024 * 1024;

function isJson(contentType) {
  return /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(contentType || '');
}

function isText(contentType) {
  return /^text\//i.test(contentType || '') || /\b(application\/xml|application\/javascript)\b/i.test(contentType || '');
}

function isForm(contentType) {
  return /\bapplication\/x-www-form-urlencoded\b/i.test(contentType || '');
}

export function classifyContentType(contentType = '') {
  if (isJson(contentType)) return 'json';
  if (isForm(contentType)) return 'form';
  if (isText(contentType) || !contentType) return 'text';
  return 'unsupported';
}

export async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      return { oversized: true, size, buffer: Buffer.alloc(0) };
    }
    chunks.push(chunk);
  }
  return { oversized: false, size, buffer: Buffer.concat(chunks) };
}

export function parsePayload({ buffer, contentType }) {
  const text = buffer.toString('utf8');
  const type = classifyContentType(contentType);
  if (type === 'unsupported') {
    return {
      supported: false,
      storageKind: 'metadata_only',
      preview: 'Unsupported payload type; body was not stored.',
      payload: null,
      sha256: digest(buffer),
      type,
    };
  }
  if (type === 'json') {
    const parsed = JSON.parse(text || 'null');
    return {
      supported: true,
      storageKind: 'inline',
      preview: previewJson(parsed),
      payload: JSON.stringify(parsed),
      sha256: digest(buffer),
      type,
    };
  }
  if (type === 'form') {
    const parsed = {};
    for (const [key, value] of new URLSearchParams(text)) {
      if (Object.hasOwn(parsed, key)) {
        parsed[key] = Array.isArray(parsed[key]) ? [...parsed[key], value] : [parsed[key], value];
      } else {
        parsed[key] = value;
      }
    }
    return {
      supported: true,
      storageKind: 'inline',
      preview: previewJson(parsed),
      payload: text,
      sha256: digest(buffer),
      type,
    };
  }
  return {
    supported: true,
    storageKind: 'inline',
    preview: truncatePreview(text),
    payload: text,
    sha256: digest(buffer),
    type,
  };
}

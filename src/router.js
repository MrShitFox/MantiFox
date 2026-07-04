const defaultBodyLimit = 1024 * 1024;

export async function readBody(req, limit = defaultBodyLimit) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

export async function readForm(req) {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const data = {};
  for (const [key, value] of params) {
    data[key] = value;
  }
  return data;
}

export function send(res, statusCode, headers, body = '') {
  res.writeHead(statusCode, headers);
  res.end(body);
}

export function sendJson(res, statusCode, payload) {
  send(res, statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, JSON.stringify(payload));
}

export function sendHtml(res, statusCode, html) {
  send(res, statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  }, html);
}

export function redirect(res, location, statusCode = 303, headers = {}) {
  send(res, statusCode, { ...headers, Location: location }, '');
}

export function methodNotAllowed(res) {
  sendJson(res, 405, { error: 'Method not allowed' });
}

export function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

export function pathParts(pathname) {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

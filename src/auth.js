import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import { config } from './config.js';
import { createSession, deleteSession, getSession } from './db.js';

export const sessionCookieName = 'mantifox_session';

const passwordSalt = createHash('sha256')
  .update(`mantifox-password:${config.sessionSecret}`)
  .digest()
  .subarray(0, 16);
const expectedPasswordHash = scryptSync(config.adminPassword, passwordSalt, 64);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

function sign(value) {
  return createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

function signedCookieValue(sessionId) {
  return `${sessionId}.${sign(sessionId)}`;
}

function verifyCookieValue(value) {
  const [sessionId, signature, ...rest] = String(value || '').split('.');
  if (!sessionId || !signature || rest.length > 0) return null;
  if (!safeEqual(signature, sign(sessionId))) return null;
  return sessionId;
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}

function cookieHeader(sessionId, expiresAt, req) {
  const attributes = [
    `${sessionCookieName}=${encodeURIComponent(signedCookieValue(sessionId))}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Expires=${new Date(expiresAt).toUTCString()}`
  ];
  if (isSecureRequest(req)) attributes.push('Secure');
  return attributes.join('; ');
}

export function verifyAdminPassword(password) {
  const actual = scryptSync(String(password || ''), passwordSalt, 64);
  return timingSafeEqual(actual, expectedPasswordHash);
}

export function createLoginSession(req) {
  const sessionId = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + config.sessionTtlMs;
  createSession(sessionId, expiresAt);
  return cookieHeader(sessionId, expiresAt, req);
}

export function getRequestSession(req) {
  const cookie = parseCookies(req.headers.cookie).get(sessionCookieName);
  const sessionId = verifyCookieValue(cookie);
  if (!sessionId) return null;

  const session = getSession(sessionId);
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    deleteSession(sessionId);
    return null;
  }

  return session;
}

export function destroyRequestSession(req) {
  const cookie = parseCookies(req.headers.cookie).get(sessionCookieName);
  const sessionId = verifyCookieValue(cookie);
  if (sessionId) deleteSession(sessionId);
}

export function expiredSessionCookie() {
  return `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

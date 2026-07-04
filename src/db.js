import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.appDbPath), { recursive: true });

export const db = new Database(config.appDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scheme TEXT NOT NULL DEFAULT 'http',
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'none',
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    bearer_token TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const connectionSelect = `
  id, name, scheme, host, port, auth_type, username, password, bearer_token,
  created_at, updated_at
`;

function now() {
  return Date.now();
}

function parseConnectionHost(rawHost, rawScheme, rawPort) {
  let scheme = rawScheme || 'http';
  let host = String(rawHost || '').trim();
  let port = rawPort;

  if (!host) {
    throw new Error('Host is required');
  }

  if (/^https?:\/\//i.test(host)) {
    const parsed = new URL(host);
    scheme = parsed.protocol.replace(':', '');
    host = parsed.hostname;
    if (!port && parsed.port) {
      port = parsed.port;
    }
  } else if (host.includes(':') && !host.startsWith('[')) {
    try {
      const parsed = new URL(`${scheme}://${host}`);
      if (parsed.hostname && parsed.port) {
        host = parsed.hostname;
        port = port || parsed.port;
      }
    } catch {
      // Keep the original host. IPv6 and validation errors are handled below.
    }
  }

  scheme = String(scheme || 'http').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error('Scheme must be http or https');
  }

  const numericPort = Number.parseInt(String(port || ''), 10);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }

  if (host.includes('/') || host.includes('?') || host.includes('#')) {
    throw new Error('Host must not include a path, query, or fragment');
  }

  return { scheme, host, port: numericPort };
}

function normalizeAuth(input, existing) {
  const authType = ['none', 'basic', 'bearer'].includes(input.auth_type)
    ? input.auth_type
    : 'none';

  if (authType === 'basic') {
    const keepPassword = existing && existing.auth_type === 'basic' && !input.password;
    return {
      auth_type: 'basic',
      username: String(input.username || '').trim(),
      password: keepPassword ? existing.password : String(input.password || ''),
      bearer_token: ''
    };
  }

  if (authType === 'bearer') {
    const keepToken = existing && existing.auth_type === 'bearer' && !input.bearer_token;
    return {
      auth_type: 'bearer',
      username: '',
      password: '',
      bearer_token: keepToken ? existing.bearer_token : String(input.bearer_token || '')
    };
  }

  return {
    auth_type: 'none',
    username: '',
    password: '',
    bearer_token: ''
  };
}

function normalizeConnectionInput(input, existing = null) {
  const parsed = parseConnectionHost(
    input.host ?? existing?.host,
    input.scheme ?? existing?.scheme,
    input.port ?? existing?.port
  );
  const auth = normalizeAuth(input, existing);
  const name = String(input.name || existing?.name || `${parsed.host}:${parsed.port}`).trim();

  if (!name) {
    throw new Error('Name is required');
  }

  return { name, ...parsed, ...auth };
}

function mapConnection(row) {
  if (!row) return null;
  return {
    ...row,
    port: Number(row.port),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at)
  };
}

export function publicConnection(connection) {
  if (!connection) return null;
  const { password, bearer_token: bearerToken, ...rest } = connection;
  return {
    ...rest,
    has_password: Boolean(password),
    has_bearer_token: Boolean(bearerToken)
  };
}

export function listConnections() {
  return db
    .prepare(`SELECT ${connectionSelect} FROM connections ORDER BY name COLLATE NOCASE, id`)
    .all()
    .map(mapConnection);
}

export function listPublicConnections() {
  return listConnections().map(publicConnection);
}

export function getConnection(id) {
  return mapConnection(
    db.prepare(`SELECT ${connectionSelect} FROM connections WHERE id = ?`).get(id)
  );
}

export function getPublicConnection(id) {
  return publicConnection(getConnection(id));
}

export function createConnection(input) {
  const connection = normalizeConnectionInput(input);
  const timestamp = now();
  const result = db
    .prepare(`
      INSERT INTO connections (
        name, scheme, host, port, auth_type, username, password, bearer_token,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      connection.name,
      connection.scheme,
      connection.host,
      connection.port,
      connection.auth_type,
      connection.username,
      connection.password,
      connection.bearer_token,
      timestamp,
      timestamp
    );

  return getConnection(result.lastInsertRowid);
}

export function updateConnection(id, input) {
  const existing = getConnection(id);
  if (!existing) return null;

  const connection = normalizeConnectionInput(input, existing);
  db.prepare(`
    UPDATE connections
    SET name = ?, scheme = ?, host = ?, port = ?, auth_type = ?, username = ?,
        password = ?, bearer_token = ?, updated_at = ?
    WHERE id = ?
  `).run(
    connection.name,
    connection.scheme,
    connection.host,
    connection.port,
    connection.auth_type,
    connection.username,
    connection.password,
    connection.bearer_token,
    now(),
    id
  );

  return getConnection(id);
}

export function deleteConnection(id) {
  return db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
}

export function createSession(sessionId, expiresAt) {
  db.prepare('INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)')
    .run(sessionId, expiresAt, now());
}

export function getSession(sessionId) {
  const row = db.prepare('SELECT id, expires_at, created_at FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return null;
  return {
    id: row.id,
    expires_at: Number(row.expires_at),
    created_at: Number(row.created_at)
  };
}

export function deleteSession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function sweepExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

sweepExpiredSessions();

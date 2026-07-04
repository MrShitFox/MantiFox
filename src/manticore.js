import { Buffer } from 'node:buffer';
import { config } from './config.js';
import { columnNames } from './html.js';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Manticore ids and `bigint` columns are 64-bit; auto-assigned ids routinely
// exceed 2^53 (e.g. 8506583095909023745). Plain JSON.parse coerces every number
// to a float64 and silently rounds those, which corrupts the id shown in the
// grid and the edit/delete links built from it. Quote integer literals that are
// too large to represent exactly (only in value position, never inside a
// string) so JSON.parse keeps them as exact strings.
function quoteUnsafeIntegers(json) {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += json[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    // Outside a string, digits only ever begin a JSON number token.
    const startsNumber = (ch >= '0' && ch <= '9')
      || (ch === '-' && json[i + 1] >= '0' && json[i + 1] <= '9');
    if (startsNumber) {
      let j = ch === '-' ? i + 1 : i;
      while (j < json.length && json[j] >= '0' && json[j] <= '9') j++;
      const isInteger = json[j] !== '.' && json[j] !== 'e' && json[j] !== 'E';
      const token = json.slice(i, j);
      out += isInteger && !Number.isSafeInteger(Number(token)) ? `"${token}"` : token;
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export function parseManticoreJson(text) {
  return JSON.parse(quoteUnsafeIntegers(text));
}

export function connectionBaseUrl(connection) {
  const host = connection.host.includes(':') && !connection.host.startsWith('[')
    ? `[${connection.host}]`
    : connection.host;
  return `${connection.scheme}://${host}:${connection.port}`;
}

function authorizationHeader(connection) {
  if (connection.auth_type === 'basic') {
    const token = Buffer.from(`${connection.username}:${connection.password}`).toString('base64');
    return `Basic ${token}`;
  }
  if (connection.auth_type === 'bearer') {
    return `Bearer ${connection.bearer_token}`;
  }
  return null;
}

export async function manticoreRequest(connection, endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || config.manticoreTimeoutMs);
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {})
  };
  const authorization = authorizationHeader(connection);
  if (authorization) headers.Authorization = authorization;

  try {
    const response = await fetch(`${connectionBaseUrl(connection)}${endpoint}`, {
      method: options.method || 'POST',
      headers,
      body: options.body,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = parseManticoreJson(text);
      } catch {
        if (response.ok) {
          throw new Error(`Manticore returned non-JSON response: ${text}`);
        }
      }
    }

    if (!response.ok) {
      const detail = payload?.error || payload?.message || text || response.statusText;
      throw new Error(`Manticore HTTP ${response.status}: ${detail}`);
    }

    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Manticore request timed out after ${options.timeoutMs || config.manticoreTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runSql(connection, sql) {
  const payload = await manticoreRequest(connection, '/sql?mode=raw', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: String(sql)
  });

  if (Array.isArray(payload)) {
    return payload;
  }

  // Some Manticore responses are not the result-set array: an error object like
  // `{ "error": "P01: syntax error ..." }` (seen with HTTP 200 on some builds),
  // or an empty body (seen for certain multi-statement runs). Surface the error
  // through the normal result-set machinery and treat an empty body as "no
  // result sets" instead of throwing a generic message that hides the cause.
  if (payload && typeof payload === 'object' && (payload.error || payload.warning)) {
    return [{
      columns: [],
      data: [],
      total: 0,
      error: payload.error || '',
      warning: payload.warning || ''
    }];
  }

  if (payload == null) return [];

  throw new Error('Manticore /sql?mode=raw returned an unexpected response shape');
}

export async function ping(connection) {
  return runSql(connection, 'SHOW VERSION');
}

export function collectMessages(results) {
  const sets = Array.isArray(results) ? results : [results];
  const messages = [];
  sets.forEach((result, index) => {
    if (result?.error) messages.push({ type: 'error', statement: index + 1, message: result.error });
    if (result?.warning) messages.push({ type: 'warning', statement: index + 1, message: result.warning });
  });
  return messages;
}

export function hasResultErrors(results) {
  return collectMessages(results).some((message) => message.type === 'error');
}

export function quoteIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) throw new Error('Identifier is required');
  return raw.split('.').map((part) => {
    if (!identifierPattern.test(part)) {
      throw new Error(`Invalid SQL identifier: ${raw}`);
    }
    return `\`${part}\``;
  }).join('.');
}

export function sqlString(value) {
  // Manticore uses MySQL-style backslash escaping in string literals (verified
  // against the server): SQL-standard quote doubling (`''`) is parsed as two
  // adjacent strings, and a backslash escapes the following character. So a
  // value ending in `\` with only quote-doubling would break out of the literal
  // (SQL injection). Escape backslashes first, then single quotes.
  return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function sqlIdLiteral(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error('Row id must be an unsigned integer');
  }
  return raw;
}

function isNumericType(type) {
  const normalized = String(type || '').toLowerCase();
  return normalized.includes('int')
    || normalized.includes('float')
    || normalized.includes('double')
    || normalized.includes('real')
    || normalized.includes('timestamp');
}

function isBooleanType(type) {
  return String(type || '').toLowerCase().includes('bool');
}

export function sqlLiteral(value, type = '') {
  if (value === null || value === undefined) return 'NULL';
  const raw = String(value);

  if (isBooleanType(type)) {
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase()) ? '1' : '0';
  }

  if (isNumericType(type)) {
    const trimmed = raw.trim();
    if (!trimmed) return '0';
    // Preserve integer literals exactly. Going through Number() would corrupt
    // bigint values above 2^53; BigInt keeps full precision and still emits a
    // digits-only literal (injection-safe).
    if (/^[+-]?\d+$/.test(trimmed)) return String(BigInt(trimmed));
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid numeric value: ${raw}`);
    }
    return String(numeric);
  }

  return sqlString(raw);
}

export function schemaFields(resultSet) {
  return (resultSet?.data || [])
    .map((row) => ({
      name: String(row.Field || ''),
      type: String(row.Type || ''),
      properties: String(row.Properties || '')
    }))
    .filter((field) => field.name);
}

export function tableRows(resultSet) {
  const columns = columnNames(resultSet);
  return (resultSet?.data || []).map((row) => {
    const nameColumn = columns.find((name) => !/^type$/i.test(name)) || columns[0];
    const typeColumn = columns.find((name) => /^type$/i.test(name));
    return {
      name: String(row[nameColumn] || ''),
      type: typeColumn ? String(row[typeColumn] || '') : '',
      row
    };
  }).filter((table) => table.name);
}

export async function listTables(connection) {
  const results = await runSql(connection, 'SHOW TABLES');
  return { results, tables: tableRows(results[0]) };
}

export async function describeTable(connection, table) {
  const results = await runSql(connection, `DESC ${quoteIdentifier(table)}`);
  return { results, fields: schemaFields(results[0]) };
}

export async function showTableStatus(connection, table) {
  return runSql(connection, `SHOW TABLE ${quoteIdentifier(table)} STATUS`);
}

function searchWhere(search) {
  return search ? ` WHERE MATCH(${sqlString(search)})` : '';
}

export async function countRows(connection, table, search = '') {
  const results = await runSql(
    connection,
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}${searchWhere(search)}`
  );
  const row = results[0]?.data?.[0] || {};
  const value = row.count ?? row['count(*)'] ?? Object.values(row)[0] ?? 0;
  return { results, total: Number(value) || 0 };
}

export async function selectRows(connection, table, options = {}) {
  const limit = Math.min(Math.max(Number.parseInt(options.limit || 25, 10) || 25, 1), 200);
  const offset = Math.max(Number.parseInt(options.offset || 0, 10) || 0, 0);
  const sort = options.sort ? ` ORDER BY ${quoteIdentifier(options.sort)} ${options.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
  const sql = `SELECT * FROM ${quoteIdentifier(table)}${searchWhere(options.search || '')}${sort} LIMIT ${offset}, ${limit}`;
  return runSql(connection, sql);
}

export async function selectRowById(connection, table, rowId) {
  return runSql(connection, `SELECT * FROM ${quoteIdentifier(table)} WHERE id = ${sqlIdLiteral(rowId)} LIMIT 1`);
}

function fieldType(fields, name) {
  return fields.find((field) => field.name === name)?.type || '';
}

function fieldNamesForWrite(fields, values, forceId) {
  const names = [];
  if (forceId !== undefined || String(values.id || '').trim()) {
    names.push('id');
  }
  for (const field of fields) {
    if (field.name === 'id') continue;
    if (Object.prototype.hasOwnProperty.call(values, field.name)) {
      names.push(field.name);
    }
  }
  return names;
}

function sqlValueForField(name, value, fields, forceId) {
  if (name === 'id') return sqlIdLiteral(forceId ?? value);
  return sqlLiteral(value, fieldType(fields, name));
}

export function buildInsertSql(table, fields, values) {
  const names = fieldNamesForWrite(fields, values);
  if (names.length === 0) throw new Error('At least one field is required');
  const columns = names.map(quoteIdentifier).join(', ');
  const literals = names.map((name) => sqlValueForField(name, values[name], fields)).join(', ');
  return `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${literals})`;
}

export function buildReplaceSql(table, rowId, fields, values) {
  const names = fieldNamesForWrite(fields, values, rowId);
  if (!names.includes('id')) names.unshift('id');
  const columns = names.map(quoteIdentifier).join(', ');
  const literals = names.map((name) => sqlValueForField(name, values[name], fields, name === 'id' ? rowId : undefined)).join(', ');
  return `REPLACE INTO ${quoteIdentifier(table)} (${columns}) VALUES (${literals})`;
}

export function buildDeleteSql(table, rowId) {
  return `DELETE FROM ${quoteIdentifier(table)} WHERE id = ${sqlIdLiteral(rowId)}`;
}

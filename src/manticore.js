import { Buffer } from 'node:buffer';
import { config } from './config.js';
import { columnNames } from './html.js';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const createColumnTypes = new Set([
  'text',
  'string',
  'int',
  'integer',
  'bigint',
  'float',
  'bool',
  'json',
  'timestamp',
  'multi',
  'multi64',
  'float_vector'
]);
const alterColumnTypes = new Set([
  'text',
  'string',
  'int',
  'integer',
  'bigint',
  'float',
  'bool',
  'json',
  'timestamp',
  'multi',
  'multi64'
]);
const rawJsonNumberMarker = Symbol('rawJsonNumber');

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

export function validateIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) throw new Error('Identifier is required');
  if (!identifierPattern.test(raw)) {
    throw new Error(`Invalid SQL identifier: ${raw}`);
  }
  return raw;
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

export function escapeMatchQuery(value) {
  return String(value ?? '').replace(/([\\@()!\-|/~"^$*=])/g, '\\$1');
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

export async function showCreateTable(connection, table) {
  const results = await runSql(connection, `SHOW CREATE TABLE ${quoteIdentifier(table)}`);
  return { results, statement: extractShowCreateStatement(results[0]) };
}

export async function showTableStatus(connection, table) {
  return runSql(connection, `SHOW TABLE ${quoteIdentifier(table)} STATUS`);
}

function searchWhere(search) {
  const query = String(search || '').trim();
  return query ? ` WHERE MATCH(${sqlString(escapeMatchQuery(query))})` : '';
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

export function buildDeleteSql(table, rowId) {
  return `DELETE FROM ${quoteIdentifier(table)} WHERE id = ${sqlIdLiteral(rowId)}`;
}

export function normalizeTableType(type) {
  return String(type || '').trim().toLowerCase();
}

export function isRealtimeTable(tableOrType) {
  const type = typeof tableOrType === 'string' ? tableOrType : tableOrType?.type;
  return normalizeTableType(type) === 'rt';
}

export function findTable(tables, tableName) {
  return (tables || []).find((table) => table.name === tableName) || null;
}

export function requireRealtimeTable(tableOrType, action = 'This action') {
  if (!isRealtimeTable(tableOrType)) {
    const type = typeof tableOrType === 'string' ? tableOrType : tableOrType?.type;
    throw Object.assign(
      new Error(`${action} is available only for rt tables${type ? `; this table is ${type}` : ''}`),
      { statusCode: 400 }
    );
  }
}

function extractShowCreateStatement(resultSet) {
  const row = resultSet?.data?.[0];
  if (!row) return '';
  const createKey = Object.keys(row).find((key) => /create/i.test(key));
  if (createKey) return String(row[createKey] ?? '');
  return String(Object.values(row).find((value) => String(value).includes('CREATE TABLE')) ?? '');
}

function checked(value) {
  return value === true || value === '1' || value === 'on' || value === 'yes' || value === 1;
}

function normalizeColumnType(type, allowedTypes) {
  const normalized = String(type || '').trim().toLowerCase();
  if (!allowedTypes.has(normalized)) {
    throw new Error(`Unsupported column type: ${type || '(empty)'}`);
  }
  return normalized;
}

function normalizeColumnInputs(input) {
  if (Array.isArray(input.columns)) {
    return input.columns.filter(Boolean);
  }

  const count = Math.max(Number.parseInt(String(input.column_count || '0'), 10) || 0, 0);
  const columns = [];
  for (let index = 0; index < count; index++) {
    const prefix = `col_${index}_`;
    const name = String(input[`${prefix}name`] || '').trim();
    const type = String(input[`${prefix}type`] || '').trim();
    if (!name && !type) continue;
    columns.push({
      name,
      type,
      indexed: input[`${prefix}indexed`],
      stored: input[`${prefix}stored`],
      attribute: input[`${prefix}attribute`],
      secondary_index: input[`${prefix}secondary_index`],
      knn_type: input[`${prefix}knn_type`],
      knn_dims: input[`${prefix}knn_dims`],
      hnsw_similarity: input[`${prefix}hnsw_similarity`]
    });
  }
  return columns;
}

function textModifiers(type, column, mode) {
  const indexed = checked(column.indexed);
  const stored = checked(column.stored);
  const attribute = checked(column.attribute);

  if (attribute && !indexed) {
    throw new Error(`${column.name}: attribute requires indexed`);
  }
  if (attribute && stored) {
    throw new Error(`${column.name}: stored cannot be combined with attribute`);
  }
  if (mode === 'alter' && stored) {
    throw new Error(`${column.name}: ALTER ADD COLUMN does not support the stored modifier`);
  }
  if (type === 'text' && !indexed && !stored) {
    throw new Error(`${column.name}: text columns must be indexed, stored, or both`);
  }
  if (type === 'string' && indexed && stored) {
    throw new Error(`${column.name}: string supports indexed, indexed attribute, stored, or no modifier`);
  }

  if (indexed && attribute) return ['indexed', 'attribute'];
  if (indexed && stored) return ['indexed', 'stored'];
  if (indexed) return ['indexed'];
  if (stored) return ['stored'];
  return [];
}

function buildColumnDefinition(column, mode = 'create') {
  const name = validateIdentifier(column.name);
  if (name.toLowerCase() === 'id') {
    throw new Error('The id column is implicit in Manticore and must not be declared');
  }

  const allowed = mode === 'alter' ? alterColumnTypes : createColumnTypes;
  const type = normalizeColumnType(column.type, allowed);
  const parts = [quoteIdentifier(name), type];

  if (type === 'text' || type === 'string') {
    parts.push(...textModifiers(type, { ...column, name }, mode));
  }

  if (type === 'json' && checked(column.secondary_index)) {
    parts.push("secondary_index='1'");
  }

  if (type === 'float_vector') {
    const knnType = String(column.knn_type || 'hnsw').trim().toLowerCase();
    const dims = String(column.knn_dims || '').trim();
    const similarity = String(column.hnsw_similarity || 'l2').trim().toLowerCase();

    if (knnType !== 'hnsw') throw new Error(`${name}: only hnsw KNN is supported by this form`);
    if (!/^[1-9]\d*$/.test(dims)) throw new Error(`${name}: vector dimensions must be a positive integer`);
    if (!['l2', 'ip', 'cosine'].includes(similarity)) {
      throw new Error(`${name}: vector similarity must be l2, ip, or cosine`);
    }

    parts.push("knn_type='hnsw'", `knn_dims=${sqlString(dims)}`, `hnsw_similarity=${sqlString(similarity)}`);
  }

  return parts.join(' ');
}

function optionValue(input, key, label, pattern = null) {
  const value = String(input[key] || '').trim();
  if (!value) return '';
  if (pattern && !pattern.test(value)) {
    throw new Error(`${label} has an invalid value`);
  }
  return `${key}=${sqlString(value)}`;
}

function buildCreateOptions(input) {
  const options = [
    optionValue(input, 'min_infix_len', 'min_infix_len', /^\d+$/),
    optionValue(input, 'morphology', 'morphology', /^[A-Za-z0-9_,.\-]+$/),
    checked(input.html_strip) ? `html_strip=${sqlString('1')}` : '',
    (() => {
      const engine = String(input.engine || '').trim().toLowerCase();
      if (!engine) return '';
      if (!['columnar', 'rowwise'].includes(engine)) throw new Error('engine must be columnar or rowwise');
      return `engine=${sqlString(engine)}`;
    })(),
    optionValue(input, 'rt_mem_limit', 'rt_mem_limit', /^\d+[KMG]?$/i)
  ].filter(Boolean);

  const extra = String(input.extra_options || '').trim();
  if (extra) {
    if (extra.includes(';')) {
      throw new Error('Extra options must be a single CREATE TABLE option list without semicolons');
    }
    options.push(extra);
  }

  return options.join(' ');
}

export function buildCreateTableSql(input) {
  const table = validateIdentifier(input.table_name || input.name);
  const columns = normalizeColumnInputs(input);
  if (!columns.length) throw new Error('At least one column is required');

  const columnSql = columns.map((column) => `  ${buildColumnDefinition(column, 'create')}`).join(',\n');
  const options = buildCreateOptions(input);
  const ifNotExists = checked(input.if_not_exists) ? ' IF NOT EXISTS' : '';
  return `CREATE TABLE${ifNotExists} ${quoteIdentifier(table)} (\n${columnSql}\n)${options ? ` ${options}` : ''}`;
}

export function buildAlterAddColumnSql(table, input) {
  const column = Array.isArray(input.columns) ? input.columns[0] : {
    name: input.column_name || input.name,
    type: input.column_type || input.type,
    indexed: input.column_indexed || input.indexed,
    stored: input.column_stored || input.stored,
    attribute: input.column_attribute || input.attribute,
    secondary_index: input.column_secondary_index || input.secondary_index
  };
  return `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${buildColumnDefinition(column, 'alter')}`;
}

export function isAttributeField(field) {
  const name = String(field?.name || '').toLowerCase();
  if (!name || name === 'id') return false;
  const type = String(field?.type || '').toLowerCase();
  const properties = String(field?.properties || '').toLowerCase();
  if (type.includes('text')) return properties.includes('attribute');
  return true;
}

export function attributeFields(fields) {
  return (fields || []).filter(isAttributeField);
}

function requireAlterableSchema(fields, action) {
  if (!attributeFields(fields).length) {
    throw new Error(`${action} is not available because ALTER requires a table with at least one attribute`);
  }
}

export function buildAlterDropColumnSql(table, columnName, fields) {
  const column = validateIdentifier(columnName);
  if (column.toLowerCase() === 'id') throw new Error('The implicit id column cannot be dropped');

  const field = (fields || []).find((candidate) => candidate.name === column);
  if (!field) throw new Error(`Column ${column} does not exist`);
  requireAlterableSchema(fields, 'DROP COLUMN');

  if (isAttributeField(field) && attributeFields(fields).length <= 1) {
    throw new Error('DROP COLUMN would leave the table with no attributes');
  }

  return `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)}`;
}

export function canModifyColumnToBigint(field) {
  const type = String(field?.type || '').toLowerCase();
  return ['int', 'integer', 'uint'].includes(type);
}

export function buildAlterModifyBigintSql(table, columnName, fields) {
  const column = validateIdentifier(columnName);
  const field = (fields || []).find((candidate) => candidate.name === column);
  if (!field) throw new Error(`Column ${column} does not exist`);
  requireAlterableSchema(fields, 'MODIFY COLUMN');
  if (!canModifyColumnToBigint(field)) {
    throw new Error('MODIFY COLUMN only supports widening an int column to bigint');
  }
  return `ALTER TABLE ${quoteIdentifier(table)} MODIFY COLUMN ${quoteIdentifier(column)} bigint`;
}

export function buildDropTableSql(table) {
  return `DROP TABLE ${quoteIdentifier(table)}`;
}

export function buildTruncateTableSql(table) {
  return `TRUNCATE TABLE ${quoteIdentifier(table)}`;
}

function rawJsonNumber(value) {
  return { [rawJsonNumberMarker]: String(value) };
}

function stringifyManticoreJson(value) {
  if (value && typeof value === 'object' && rawJsonNumberMarker in value) {
    return value[rawJsonNumberMarker];
  }
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyManticoreJson(item) ?? 'null').join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, entry]) => {
      const rendered = stringifyManticoreJson(entry);
      return rendered === undefined ? '' : `${JSON.stringify(key)}:${rendered}`;
    }).filter(Boolean).join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON number must be finite');
    return String(value);
  }
  return JSON.stringify(value);
}

function integerJsonValue(value, { signed = false, empty = '0', label = 'value' } = {}) {
  const raw = String(value ?? '').trim();
  const normalized = raw || empty;
  const pattern = signed ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(normalized)) {
    throw new Error(`${label} must be ${signed ? 'an integer' : 'an unsigned integer'}`);
  }
  return rawJsonNumber(String(BigInt(normalized)));
}

function floatJsonValue(value, label = 'value') {
  const raw = String(value ?? '').trim();
  const numeric = Number(raw || '0');
  if (!Number.isFinite(numeric)) throw new Error(`${label} must be a finite number`);
  return numeric;
}

function timestampJsonValue(value, label = 'timestamp') {
  const raw = String(value ?? '').trim();
  if (!raw) return rawJsonNumber('0');
  if (/^\d+$/.test(raw)) return rawJsonNumber(raw);

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date/time`);
  return rawJsonNumber(String(Math.floor(parsed / 1000)));
}

function jsonAttributeValue(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function parseArrayInput(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new Error(`${label} must be a JSON array or comma-separated list`);
    }
  }
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

function valueForJsonDoc(field, value) {
  const label = field.name;
  const type = String(field.type || '').toLowerCase();
  if (type.includes('bool')) return checked(value) ? 1 : 0;
  if (type.includes('bigint')) return integerJsonValue(value, { signed: true, label });
  if (type === 'int' || type === 'integer' || type === 'uint') {
    return integerJsonValue(value, { signed: false, label });
  }
  if (type.includes('timestamp')) return timestampJsonValue(value, label);
  if (type.includes('float_vector')) {
    return parseArrayInput(value, label).map((item) => floatJsonValue(item, label));
  }
  if (type.includes('float')) return floatJsonValue(value, label);
  if (type.includes('json')) return jsonAttributeValue(value, label);
  if (type.includes('multi64')) {
    return parseArrayInput(value, label).map((item) => integerJsonValue(item, { signed: true, label }));
  }
  if (type.includes('multi')) {
    return parseArrayInput(value, label).map((item) => integerJsonValue(item, { signed: false, label }));
  }
  return String(value ?? '');
}

export function rowPayloadFromValues(fields, values, forcedId = undefined) {
  const doc = {};
  let id = forcedId === undefined ? undefined : integerJsonValue(forcedId, { signed: false, label: 'Row id' });

  for (const field of fields || []) {
    if (field.name === 'id') {
      const rawId = forcedId === undefined ? values?.id : forcedId;
      if (rawId !== undefined && String(rawId).trim()) {
        id = integerJsonValue(rawId, { signed: false, label: 'Row id' });
      }
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(values || {}, field.name)) {
      doc[field.name] = valueForJsonDoc(field, values[field.name]);
    }
  }

  return { id, doc };
}

function jsonTableName(table) {
  return validateIdentifier(table);
}

async function runJsonAction(connection, endpoint, payload) {
  return manticoreRequest(connection, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: stringifyManticoreJson(payload)
  });
}

export async function insertDocument(connection, table, fields, values) {
  const { id, doc } = rowPayloadFromValues(fields, values);
  return runJsonAction(connection, '/insert', {
    table: jsonTableName(table),
    id,
    doc
  });
}

export async function replaceDocument(connection, table, rowId, fields, values) {
  const { id, doc } = rowPayloadFromValues(fields, values, rowId);
  return runJsonAction(connection, '/replace', {
    table: jsonTableName(table),
    id,
    doc
  });
}

export function collectJsonMessages(payload) {
  const messages = [];
  if (!payload || typeof payload !== 'object') return messages;
  if (payload.error) messages.push({ type: 'error', message: String(payload.error) });
  if (payload.warning) messages.push({ type: 'warning', message: String(payload.warning) });
  if (payload.errors) {
    messages.push({ type: 'error', message: typeof payload.errors === 'string' ? payload.errors : 'Manticore reported JSON endpoint errors' });
  }
  if (Array.isArray(payload.items)) {
    payload.items.forEach((item, index) => {
      const action = item && typeof item === 'object' ? Object.values(item)[0] : null;
      if (action?.error) messages.push({ type: 'error', statement: index + 1, message: String(action.error) });
      if (action?.warning) messages.push({ type: 'warning', statement: index + 1, message: String(action.warning) });
    });
  }
  return messages;
}

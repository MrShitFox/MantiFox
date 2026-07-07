import { Buffer } from 'node:buffer';
import { config } from './config.js';
import { columnNames, valueToText } from './html.js';

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

// Manticore error/warning fields are usually strings, but several builds return
// an object (e.g. `{ type, reason, index }`) for the JSON HTTP endpoints
// (/insert, /replace). Coercing those with a template literal yields the
// useless "[object Object]" and hides the real cause, so render a readable line.
export function manticoreErrorText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const reason = value.reason || value.error || value.message || value.type;
    if (reason && typeof reason === 'string') {
      return value.index ? `${reason} (index: ${value.index})` : reason;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
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
      const detail = manticoreErrorText(payload?.error) || manticoreErrorText(payload?.message)
        || text || response.statusText;
      // manticoreStatus marks "the node answered, the query itself failed"
      // (Manticore uses 500 even for plain syntax errors) as opposed to the
      // transport failures below — callers can render these inline instead of
      // treating them like an unreachable node.
      throw Object.assign(new Error(`Manticore HTTP ${response.status}: ${detail}`), {
        manticoreStatus: response.status
      });
    }

    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(
        new Error(`Manticore request timed out after ${options.timeoutMs || config.manticoreTimeoutMs}ms`),
        { statusCode: 504 }
      );
    }
    // fetch() rejects with a TypeError on transport failures (connection
    // refused, DNS, TLS). The raw message is just "fetch failed"; surface which
    // endpoint failed and the OS-level cause so the error is actionable.
    if (error instanceof TypeError) {
      const cause = error.cause?.code || error.cause?.message || error.message;
      throw Object.assign(
        new Error(`Could not reach Manticore at ${connectionBaseUrl(connection)}: ${cause}`),
        { statusCode: 502 }
      );
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

// The /sql?mode=raw endpoint reliably accepts only ONE statement per request
// (multi-statement input returns a P01 syntax error - verified against the
// node), so console input has to be split and submitted statement by
// statement. The scanner tracks '...' literals (backslash escapes), `...`
// identifiers and /* */ comments so a ';' inside them never splits. Line
// comments (-- with trailing whitespace, #) are dropped entirely: Manticore
// rejects them outright (verified P02 errors), while block comments pass
// through because the server accepts them and /*+ ... */ carries hints.
export function splitSqlStatements(sql) {
  const text = String(sql ?? '');
  const statements = [];
  let current = '';
  let hasContent = false;
  let i = 0;

  const flush = () => {
    const statement = current.trim();
    if (hasContent && statement) statements.push(statement);
    current = '';
    hasContent = false;
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "'" || ch === '`') {
      hasContent = true;
      current += ch;
      i++;
      while (i < text.length && text[i] !== ch) {
        current += text[i];
        if (ch === "'" && text[i] === '\\' && i + 1 < text.length) {
          current += text[i + 1];
          i++;
        }
        i++;
      }
      if (i < text.length) {
        current += ch;
        i++;
      }
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      current += '/*';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        current += text[i];
        i++;
      }
      if (i < text.length) {
        current += '*/';
        i += 2;
      }
      continue;
    }

    // MySQL rule: `--` opens a comment only when followed by whitespace or the
    // end of input, so expressions like 1--2 keep their meaning.
    if (ch === '#' || (ch === '-' && text[i + 1] === '-' && (i + 2 >= text.length || /\s/.test(text[i + 2])))) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (ch === ';') {
      flush();
      i++;
      continue;
    }

    if (!/\s/.test(ch)) hasContent = true;
    current += ch;
    i++;
  }

  flush();
  return statements;
}

// Runs pre-split statements sequentially and stops after the first failure so
// later statements never run against a broken precondition (e.g. an INSERT
// after its CREATE TABLE failed). `skipped` reports how many statements were
// abandoned. A transport failure on the FIRST statement still throws - the
// callers' existing unreachable-node rendering handles that case - but once
// partial results exist the failure is folded into them as an error set.
export async function runSqlStatements(connection, statements) {
  const results = [];
  let skipped = 0;

  for (let index = 0; index < statements.length; index++) {
    let sets;
    try {
      sets = await runSql(connection, statements[index]);
    } catch (error) {
      if (index === 0) throw error;
      sets = [{ columns: [], data: [], total: 0, error: error.message || String(error), warning: '' }];
    }
    if (!Array.isArray(sets) || !sets.length) {
      sets = [{ columns: [], data: [], total: 0, error: '', warning: '' }];
    }
    results.push(...sets);
    if (sets.some((set) => set?.error)) {
      skipped = statements.length - index - 1;
      break;
    }
  }

  return { results, skipped };
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

function badInput(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function validateIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) throw badInput('Identifier is required');
  if (!identifierPattern.test(raw)) {
    throw badInput(`Invalid SQL identifier: ${raw}`);
  }
  return raw;
}

export function quoteIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) throw badInput('Identifier is required');
  return raw.split('.').map((part) => {
    if (!identifierPattern.test(part)) {
      throw badInput(`Invalid SQL identifier: ${raw}`);
    }
    return `\`${part}\``;
  }).join('.');
}

export function escapeMatchQuery(value) {
  return String(value ?? '').replace(/([\\@()!\-|/~"^$*=<'])/g, '\\$1');
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
    throw badInput('Row id must be an unsigned integer');
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

// max_matches result slots are held in memory per query, so paging is capped
// instead of letting a deep offset (OPTION max_matches=1000000025) exhaust the
// node's RAM. Deeper access belongs in the SQL console with an explicit
// OPTION max_matches.
export const maxBrowseWindow = 1000000;

export async function selectRows(connection, table, options = {}) {
  const limit = Math.min(Math.max(Number.parseInt(options.limit || 25, 10) || 25, 1), 200);
  const offset = Math.max(Number.parseInt(options.offset || 0, 10) || 0, 0);
  if (offset + limit > maxBrowseWindow) {
    throw badInput(`Cannot browse past row ${maxBrowseWindow}; narrow the search or use the SQL console with OPTION max_matches`);
  }
  const sort = options.sort ? ` ORDER BY ${quoteIdentifier(options.sort)} ${options.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
  // Manticore rejects OFFSET past max_matches (default 1000), which kills
  // pagination beyond row 1000; raise it to exactly what this page needs.
  const maxMatches = offset + limit > 1000 ? ` OPTION max_matches=${offset + limit}` : '';
  const sql = `SELECT * FROM ${quoteIdentifier(table)}${searchWhere(options.search || '')}${sort} LIMIT ${offset}, ${limit}${maxMatches}`;
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
  // DESC reports MVA columns as `mva` / `mva64`, not `multi` / `multi64`;
  // accept both spellings or every row write on such tables fails with
  // "non-MVA value specified for a MVA column".
  if (type.includes('multi64') || type.includes('mva64')) {
    return parseArrayInput(value, label).map((item) => integerJsonValue(item, { signed: true, label }));
  }
  if (type.includes('multi') || type.includes('mva')) {
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

// Fields UPDATE cannot write in place: full-text content lives in the FT index
// (only REPLACE reindexes it — and updating just the attribute half of a
// `string indexed attribute` column leaves the FT index matching the OLD value,
// verified against the node), and float_vector goes down the MVA parser on
// /update and errors. Everything else is a row-wise attribute.
export function isReplaceOnlyField(field) {
  const type = String(field?.type || '').toLowerCase();
  const properties = String(field?.properties || '').toLowerCase();
  return type.includes('text') || type.includes('float_vector') || properties.includes('indexed');
}

function normalizeFormText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

// Decide how to save an edited row (§4.3 bug #5): UPDATE when only attributes
// changed (in-place, preserves full-text content REPLACE would wipe), REPLACE
// only when a replace-only field actually changed. Readability is data-driven:
// SELECT * omits columns that cannot be read back (verified), so a missing key
// on the loaded row marks the field unreadable — for those, any non-empty
// submitted value counts as a change (empty means "leave as is").
// `lossless` reports whether REPLACE would lose nothing (every replace-only
// field readable), so callers know when a failed UPDATE may retry as REPLACE.
export function planRowSave({ fields, currentRow, values }) {
  const submitted = (name) => Object.prototype.hasOwnProperty.call(values || {}, name);
  const replaceOnly = (fields || []).filter((field) => field.name !== 'id' && isReplaceOnlyField(field));

  const lossless = replaceOnly.every(
    (field) => currentRow && Object.prototype.hasOwnProperty.call(currentRow, field.name)
  );

  if (!currentRow) return { mode: 'replace', lossless: false };

  let changed = false;
  for (const field of replaceOnly) {
    if (!submitted(field.name)) continue;
    const value = normalizeFormText(values[field.name]);
    if (Object.prototype.hasOwnProperty.call(currentRow, field.name)) {
      if (value !== normalizeFormText(valueToText(currentRow[field.name]))) {
        changed = true;
        break;
      }
    } else if (value.trim() !== '') {
      changed = true;
      break;
    }
  }
  if (changed) return { mode: 'replace', lossless };

  const hasAttributeInput = (fields || []).some(
    (field) => field.name !== 'id' && !isReplaceOnlyField(field) && submitted(field.name)
  );
  return { mode: hasAttributeInput ? 'update' : 'none', lossless };
}

// In-place attribute write (POST /update). Replace-only fields are excluded
// from the doc — the caller only takes this path when none of them changed.
export async function updateDocument(connection, table, rowId, fields, values) {
  const attributeFieldList = (fields || []).filter((field) => !isReplaceOnlyField(field));
  const { id, doc } = rowPayloadFromValues(attributeFieldList, values, rowId);
  return runJsonAction(connection, '/update', {
    table: jsonTableName(table),
    id,
    doc
  });
}

// Save an edited row: UPDATE for attribute-only changes, REPLACE only when a
// replace-only field changed (§4.3 bug #5 — an unconditional REPLACE wiped the
// indexed content of non-stored text fields on every attribute edit).
export async function saveRow(connection, table, rowId, fields, values) {
  const rowResults = await selectRowById(connection, table, rowId);
  const currentRow = rowResults[0]?.data?.[0] || null;
  const plan = planRowSave({ fields, currentRow, values });

  if (plan.mode === 'none') return { plan, payload: null };
  if (plan.mode === 'replace') {
    return { plan, payload: await replaceDocument(connection, table, rowId, fields, values) };
  }
  try {
    return { plan, payload: await updateDocument(connection, table, rowId, fields, values) };
  } catch (error) {
    // Storage-level UPDATE rejection (e.g. a columnar attribute). REPLACE is a
    // safe retry only when every replace-only field is readable, so the full
    // document can be resent without losing anything.
    if (error.manticoreStatus && plan.lossless) {
      return {
        plan: { ...plan, mode: 'replace' },
        payload: await replaceDocument(connection, table, rowId, fields, values)
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Full-text search (the Search UI, §4.7)
// ---------------------------------------------------------------------------

// Rankers accepted by OPTION ranker= (§4.7). expr()/export need a formula
// argument, so the dropdown offers only the parameterless ones.
export const searchRankers = [
  'proximity_bm25',
  'bm25',
  'none',
  'wordcount',
  'proximity',
  'matchany',
  'fieldmask',
  'sph04'
];
export const defaultRanker = 'proximity_bm25';

// HIGHLIGHT() output must stay escapable: the snippets are wrapped in these
// private-use sentinels (verified they survive the round trip), the whole
// string is HTML-escaped, and only then are the sentinels turned into real
// <mark> tags — so the ONLY markup in a snippet is the highlight itself.
export const highlightBefore = '\uE000';
export const highlightAfter = '\uE001';

export function isTextField(field) {
  return String(field?.type || '').toLowerCase().includes('text');
}

export function textFields(fields) {
  return (fields || []).filter(isTextField);
}

// HIGHLIGHT() reads from the docstore, so only stored text fields can produce
// snippets (an indexed-only field returns '' — verified against the node).
export function storedTextFields(fields) {
  return textFields(fields).filter((field) => String(field.properties || '').toLowerCase().includes('stored'));
}

// Attributes usable for WHERE filters and FACET. json needs a subkey path and
// float_vector is KNN-only, so both stay out of the dropdowns.
export function filterableFields(fields) {
  return attributeFields(fields).filter((field) => {
    const type = String(field.type || '').toLowerCase();
    return !type.includes('json') && !type.includes('float_vector');
  });
}

const filterOperators = new Set(['=', '!=', '<', '<=', '>', '>=']);
const equalityOnly = new Set(['=', '!=']);

function filterValueSql(field, value, label) {
  const type = String(field.type || '').toLowerCase();
  const raw = String(value ?? '').trim();
  if (type.includes('bool')) {
    if (!['0', '1', 'true', 'false'].includes(raw.toLowerCase())) {
      throw badInput(`${label}: bool filters take 0 or 1`);
    }
    return ['1', 'true'].includes(raw.toLowerCase()) ? '1' : '0';
  }
  if (type.includes('float')) {
    if (!raw || !Number.isFinite(Number(raw))) throw badInput(`${label} must be a finite number`);
    return String(Number(raw));
  }
  if (type.includes('timestamp')) {
    if (/^\d+$/.test(raw)) return raw;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) throw badInput(`${label} must be a unix timestamp or a parseable date`);
    return String(Math.floor(parsed / 1000));
  }
  if (type.includes('bigint') || type.includes('mva64') || type.includes('multi64')) {
    if (!/^-?\d+$/.test(raw)) throw badInput(`${label} must be an integer`);
    return String(BigInt(raw));
  }
  if (type === 'uint' || type.includes('int') || type.includes('mva') || type.includes('multi')) {
    if (!/^\d+$/.test(raw)) throw badInput(`${label} must be an unsigned integer`);
    return String(BigInt(raw));
  }
  // string attributes and `text ... attribute` columns compare as strings
  return sqlString(raw);
}

// One attribute filter: { attr, op, value } -> validated SQL condition.
// Identifiers are validated (never escaped), operators come from a fixed set,
// values are typed per the DESC type and escaped/normalized accordingly.
export function buildFilterCondition(fields, filter) {
  const attr = validateIdentifier(filter.attr);
  const field = filterableFields(fields).find((candidate) => candidate.name === attr);
  if (!field) throw badInput(`${attr} is not a filterable attribute of this table`);
  const op = String(filter.op || '=').trim();
  if (!filterOperators.has(op)) throw badInput(`Unsupported filter operator: ${op}`);
  const type = String(field.type || '').toLowerCase();
  const stringLike = !['bool', 'float', 'timestamp', 'bigint', 'uint', 'int'].some((numeric) => type.includes(numeric))
    && !type.includes('mva') && !type.includes('multi');
  if ((stringLike || type.includes('bool') || type.includes('mva') || type.includes('multi')) && !equalityOnly.has(op)) {
    throw badInput(`${attr}: ${field.type} filters support only = and !=`);
  }
  return `${quoteIdentifier(attr)} ${op} ${filterValueSql(field, filter.value, attr)}`;
}

// The MATCH() expression for the two UI modes (§4.6/§4.7):
// - plain: user text is matched literally — BOTH the full-text operators and
//   (later, in sqlString) the SQL literal are escaped;
// - advanced: the user is typing operators on purpose — only the SQL literal
//   layer applies (sqlString at build time), operators pass through.
// Field scoping wraps the query with @field / @(f1,f2).
export function buildMatchExpression({ mode, query, fieldNames = [], allTextFieldNames = [], fuzzy = false }) {
  const raw = String(query || '').trim();
  if (!raw) return '';

  if (fuzzy) {
    // Buddy re-embeds the fuzzy MATCH string into an internal call and chokes
    // on anything but words / a quoted phrase (verified: even a correctly
    // SQL-escaped apostrophe is a server-side syntax error). Reject early with
    // an actionable message instead of sending a doomed statement; field
    // scoping is equally off-limits (it would inject the @ operator).
    if (!/^[\p{L}\p{N}\s"]+$/u.test(raw)) {
      throw badInput('Fuzzy search accepts plain words (and an optional "quoted phrase") only. Remove operators, apostrophes and other special characters, or turn fuzzy off.');
    }
    if (((raw.match(/"/g) || []).length % 2) !== 0) {
      throw badInput('Fuzzy search: unbalanced quotes in the query');
    }
    return raw;
  }

  const scoped = [...new Set(fieldNames)].filter((name) => allTextFieldNames.includes(name));
  const allSelected = scoped.length === 0 || scoped.length === allTextFieldNames.length;
  const body = mode === 'advanced' ? raw : escapeMatchQuery(raw);
  if (allSelected) return body;
  scoped.forEach((name) => validateIdentifier(name));
  const scope = scoped.length === 1 ? `@${scoped[0]}` : `@(${scoped.join(',')})`;
  return mode === 'advanced' ? `${scope} (${body})` : `${scope} ${body}`;
}

function fuzzyOptionSql({ fuzzy, distance, preserve, layouts }) {
  if (!fuzzy) return [];
  const options = ['fuzzy=1'];
  if (distance !== undefined && distance !== null && String(distance).trim() !== '') {
    const value = Number.parseInt(String(distance), 10);
    if (!Number.isInteger(value) || value < 0 || value > 4) throw badInput('Fuzzy distance must be an integer between 0 and 4');
    options.push(`distance=${value}`);
  }
  if (preserve) options.push('preserve=1');
  const layoutList = String(layouts || '').trim();
  if (layoutList) {
    if (!/^[a-z]{2}(,[a-z]{2})*$/i.test(layoutList)) throw badInput("Fuzzy layouts must look like 'us,ru'");
    options.push(`layouts=${sqlString(layoutList.toLowerCase())}`);
  }
  return options;
}

function fieldWeightOptionSql(weights, allTextFieldNames) {
  const entries = Object.entries(weights || {})
    .filter(([, value]) => String(value ?? '').trim() !== '')
    .map(([name, value]) => {
      validateIdentifier(name);
      if (!allTextFieldNames.includes(name)) throw badInput(`${name} is not a text field, so it cannot carry a field weight`);
      const weight = Number.parseInt(String(value), 10);
      if (!Number.isInteger(weight) || weight < 0 || weight > 1000000) {
        throw badInput(`Field weight for ${name} must be an integer between 0 and 1000000`);
      }
      return `${name}=${weight}`;
    });
  return entries.length ? [`field_weights=(${entries.join(', ')})`] : [];
}

export const searchFacetLimit = 12;

// The one-statement search SELECT (§4.7): match + filters + highlight +
// ranking options + optional FACET. In attribute-scan mode (no MATCH) the
// score/highlight/ranker parts simply drop out and the same statement becomes
// a filtered scan. Set appendMeta only when the capability probe confirmed
// multi-statement `; SHOW META` works on this node (§4.1 forbids relying on it).
export function buildSearchSql({
  table,
  fields,
  matchExpression = '',
  filters = [],
  ranker = defaultRanker,
  weights = {},
  fuzzy = false,
  distance,
  preserve = false,
  layouts = '',
  facet = '',
  limit,
  offset,
  appendMeta = false
}) {
  const tableSql = quoteIdentifier(table);
  const hasMatch = Boolean(matchExpression);
  const allTextFieldNames = textFields(fields).map((field) => field.name);

  const select = ['*'];
  if (hasMatch) {
    select.push('weight() AS _mfx_score');
    for (const field of storedTextFields(fields)) {
      validateIdentifier(field.name);
      select.push(
        `HIGHLIGHT({before_match=${sqlString(highlightBefore)},after_match=${sqlString(highlightAfter)},around=8,limit=300},${sqlString(field.name)}) AS _mfx_hl_${field.name}`
      );
    }
  }

  const where = [];
  if (hasMatch) where.push(`MATCH(${sqlString(matchExpression)})`);
  for (const filter of filters) where.push(buildFilterCondition(fields, filter));

  const options = [];
  if (hasMatch) {
    if (!searchRankers.includes(ranker)) throw badInput(`Unknown ranker: ${ranker}`);
    options.push(`ranker=${ranker}`);
    options.push(...fieldWeightOptionSql(weights, allTextFieldNames));
    options.push(...fuzzyOptionSql({ fuzzy, distance, preserve, layouts }));
  }
  // Manticore rejects a window past max_matches (default 1000, §4.2); raise it
  // to exactly this page's needs. The caller clamps offset+limit to
  // maxBrowseWindow before we get here.
  if (offset + limit > 1000) options.push(`max_matches=${offset + limit}`);

  let facetSql = '';
  if (facet) {
    const facetField = filterableFields(fields).find((candidate) => candidate.name === facet);
    if (!facetField) throw badInput(`${facet} is not a facetable attribute of this table`);
    facetSql = ` FACET ${quoteIdentifier(facet)} ORDER BY COUNT(*) DESC LIMIT ${searchFacetLimit}`;
  }

  const sql = `SELECT ${select.join(', ')} FROM ${tableSql}`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ` LIMIT ${offset}, ${limit}`
    + (options.length ? ` OPTION ${options.join(', ')}` : '')
    + facetSql;

  return appendMeta ? `${sql}; SHOW META` : sql;
}

// COUNT for pagination. Fuzzy options change what matches, so they must ride
// along; ranker/weights only affect ordering and stay out.
export function buildSearchCountSql({ table, fields, matchExpression = '', filters = [], fuzzy = false, distance, preserve, layouts = '' }) {
  const where = [];
  if (matchExpression) where.push(`MATCH(${sqlString(matchExpression)})`);
  for (const filter of filters) where.push(buildFilterCondition(fields, filter));
  const options = matchExpression ? fuzzyOptionSql({ fuzzy, distance, preserve, layouts }) : [];
  return `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + (options.length ? ` OPTION ${options.join(', ')}` : '');
}

// --- capability probes (once per connection, cached) -----------------------

const capabilityCacheTtlMs = 10 * 60 * 1000;
const capabilityCache = new Map();

function capabilityCacheKey(connection) {
  return [connection.id ?? '', connectionBaseUrl(connection), connection.auth_type ?? '', connection.username ?? ''].join('|');
}

// Feature-detect per connection (§4.7). `buddy` (SHOW VERSION lists a Buddy
// component) gates the fuzzy/autocomplete/suggest controls. `multiMeta`
// tracks whether this node handles `SELECT ...; SHOW META` in one request:
// multi-statement is not dependable across versions (§4.1) and a standalone
// probe statement is not either (verified: `SELECT 1; SHOW META` errors and
// `SHOW TABLES; SHOW META` collapses to one result set on a node where the
// real search shape works) — so it starts optimistic and the FIRST real
// search demotes it via demoteMultiMeta() when the node lets us down; the
// search itself always retries as a single statement.
export async function searchCapabilities(connection) {
  const key = capabilityCacheKey(connection);
  const cached = capabilityCache.get(key);
  if (cached && Date.now() - cached.at < capabilityCacheTtlMs) return cached.value;

  const value = { buddy: false, multiMeta: true };
  try {
    const versionSets = await runSql(connection, 'SHOW VERSION');
    value.buddy = (versionSets[0]?.data || []).some((row) => (
      String(row.Component || '').toLowerCase() === 'buddy' && String(row.Version || '').trim() !== ''
    ));
  } catch {
    // no answer -> just hide the Buddy-gated controls
  }

  capabilityCache.set(key, { at: Date.now(), value });
  return value;
}

// Called when a real `<search>; SHOW META` request failed or came back in an
// unexpected shape: stop appending META for this connection so later searches
// go straight to the single-statement + CALL KEYWORDS fallback.
export function demoteMultiMeta(connection) {
  const cached = capabilityCache.get(capabilityCacheKey(connection));
  if (cached) cached.value.multiMeta = false;
}

// min_infix_len from SHOW TABLE <t> SETTINGS ("settings" row carries the
// option list as one string). Autocomplete/suggest need it > 0.
export function parseMinInfixLen(settingsResultSet) {
  for (const row of settingsResultSet?.data || []) {
    const match = /(?:^|\s)min_infix_len\s*=\s*'?(\d+)'?/.exec(String(row.Value ?? ''));
    if (match) return Number.parseInt(match[1], 10);
  }
  return 0;
}

export async function showTableSettings(connection, table) {
  return runSql(connection, `SHOW TABLE ${quoteIdentifier(table)} SETTINGS`);
}

// --- SHOW META / CALL KEYWORDS -> one insight shape -------------------------

// SHOW META rows -> { total, totalFound, time, keywords[] }. The meta set is
// identified by its Variable_name/Value columns; keyword[i]/docs[i]/hits[i]
// triples are folded into rows.
export function parseShowMeta(resultSet) {
  const variables = {};
  const keywords = [];
  for (const row of resultSet?.data || []) {
    const name = String(row.Variable_name ?? '');
    const value = String(row.Value ?? '');
    const indexed = /^(keyword|docs|hits)\[(\d+)\]$/.exec(name);
    if (indexed) {
      const index = Number.parseInt(indexed[2], 10);
      keywords[index] = keywords[index] || { keyword: '', docs: '', hits: '' };
      keywords[index][indexed[1] === 'keyword' ? 'keyword' : indexed[1]] = value;
    } else {
      variables[name] = value;
    }
  }
  return {
    total: variables.total ?? '',
    totalFound: variables.total_found ?? '',
    totalRelation: variables.total_relation ?? '',
    time: variables.time ?? '',
    keywords: keywords.filter(Boolean)
  };
}

export function looksLikeMetaSet(resultSet) {
  return (resultSet?.data || []).some((row) => row && typeof row === 'object' && 'Variable_name' in row);
}

// CALL KEYWORDS(..., 1 AS stats) fallback when the node cannot do
// `; SHOW META` in one request: per-keyword docs/hits, same insight shape.
export async function callKeywordStats(connection, table, matchExpression) {
  const sql = `CALL KEYWORDS(${sqlString(matchExpression)}, ${sqlString(validateIdentifier(table))}, 1 AS stats)`;
  const results = await runSql(connection, sql);
  const keywords = (results[0]?.data || []).map((row) => ({
    keyword: String(row.normalized ?? row.tokenized ?? ''),
    docs: String(row.docs ?? ''),
    hits: String(row.hits ?? '')
  }));
  return { results, keywords };
}

export async function explainQuery(connection, table, matchExpression) {
  return runSql(connection, `EXPLAIN QUERY ${quoteIdentifier(table)} ${sqlString(matchExpression)}`);
}

// --- Buddy extras: autocomplete + did-you-mean ------------------------------

export async function callAutocomplete(connection, table, prefix) {
  const results = await runSql(
    connection,
    `CALL AUTOCOMPLETE(${sqlString(prefix)}, ${sqlString(validateIdentifier(table))})`
  );
  const suggestions = (results[0]?.data || [])
    .map((row) => String(row.query ?? Object.values(row)[0] ?? ''))
    .filter(Boolean);
  return { results, suggestions };
}

// QSUGGEST corrects the LAST word of the query — good for did-you-mean.
export async function callQsuggest(connection, table, query) {
  const results = await runSql(
    connection,
    `CALL QSUGGEST(${sqlString(query)}, ${sqlString(validateIdentifier(table))})`
  );
  const suggestions = (results[0]?.data || []).map((row) => ({
    suggest: String(row.suggest ?? ''),
    distance: Number(row.distance ?? 0),
    docs: String(row.docs ?? '')
  })).filter((row) => row.suggest);
  return { results, suggestions };
}

export function collectJsonMessages(payload) {
  const messages = [];
  if (!payload || typeof payload !== 'object') return messages;
  if (payload.error) messages.push({ type: 'error', message: manticoreErrorText(payload.error) });
  if (payload.warning) messages.push({ type: 'warning', message: manticoreErrorText(payload.warning) });
  if (payload.errors) {
    messages.push({ type: 'error', message: manticoreErrorText(payload.errors) || 'Manticore reported JSON endpoint errors' });
  }
  if (Array.isArray(payload.items)) {
    payload.items.forEach((item, index) => {
      const action = item && typeof item === 'object' ? Object.values(item)[0] : null;
      if (action?.error) messages.push({ type: 'error', statement: index + 1, message: manticoreErrorText(action.error) });
      if (action?.warning) messages.push({ type: 'warning', statement: index + 1, message: manticoreErrorText(action.warning) });
    });
  }
  return messages;
}

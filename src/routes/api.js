import {
  buildDeleteSql,
  collectJsonMessages,
  collectMessages,
  countRows,
  describeTable,
  findTable,
  hasResultErrors,
  insertDocument,
  listTables,
  ping,
  replaceDocument,
  requireRealtimeTable,
  runSql,
  selectRowById,
  selectRows,
  showTableStatus
} from '../manticore.js';
import {
  createConnection,
  deleteConnection,
  getConnection,
  getPublicConnection,
  listPublicConnections,
  publicConnection,
  updateConnection
} from '../db.js';
import { clampInteger, methodNotAllowed, pathParts, readJson, sendJson } from '../router.js';

export async function handleApi(req, res, url) {
  const parts = pathParts(url.pathname);
  if (parts[0] !== 'api') return false;

  try {
    if (parts[1] === 'connections') {
      await handleConnectionsApi(req, res, url, parts.slice(2));
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Internal server error' });
    return true;
  }
}

async function handleConnectionsApi(req, res, url, parts) {
  if (parts.length === 0) {
    if (req.method === 'GET') return sendJson(res, 200, { connections: listPublicConnections() });
    if (req.method === 'POST') {
      const connection = createConnection(await readJson(req));
      return sendJson(res, 201, { connection: publicConnection(connection) });
    }
    return methodNotAllowed(res);
  }

  const id = Number.parseInt(parts[0], 10);
  const connection = getConnection(id);
  if (!connection) return sendJson(res, 404, { error: 'Connection not found' });

  if (parts.length === 1) {
    if (req.method === 'GET') return sendJson(res, 200, { connection: getPublicConnection(id) });
    if (req.method === 'PUT') return updateConnectionApi(req, res, id);
    if (req.method === 'DELETE') {
      deleteConnection(id);
      return sendJson(res, 200, { ok: true });
    }
    return methodNotAllowed(res);
  }

  if (parts[1] === 'test' && parts.length === 2) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const results = await ping(connection);
    return sendJson(res, hasResultErrors(results) ? 502 : 200, {
      ok: !hasResultErrors(results),
      messages: collectMessages(results),
      results
    });
  }

  if (parts[1] === 'sql' && parts.length === 2) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const body = await readJson(req);
    if (!body.sql || !String(body.sql).trim()) {
      return sendJson(res, 400, { error: 'SQL is required' });
    }
    const results = await runSql(connection, body.sql);
    return sendJson(res, 200, { results, messages: collectMessages(results) });
  }

  if (parts[1] === 'tables') {
    return handleTablesApi(req, res, url, connection, parts.slice(2));
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function updateConnectionApi(req, res, id) {
  const connection = updateConnection(id, await readJson(req));
  if (!connection) return sendJson(res, 404, { error: 'Connection not found' });
  return sendJson(res, 200, { connection: publicConnection(connection) });
}

async function handleTablesApi(req, res, url, connection, parts) {
  if (parts.length === 0) {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const { results, tables } = await listTables(connection);
    return sendJson(res, 200, { tables, results, messages: collectMessages(results) });
  }

  const table = parts[0];

  if (parts.length === 2 && parts[1] === 'schema') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const { results, fields } = await describeTable(connection, table);
    return sendJson(res, 200, { fields, results, messages: collectMessages(results) });
  }

  if (parts.length === 2 && parts[1] === 'status') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const results = await showTableStatus(connection, table);
    return sendJson(res, 200, { results, messages: collectMessages(results) });
  }

  if (parts[1] === 'rows') {
    return handleRowsApi(req, res, url, connection, table, parts.slice(2));
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function handleRowsApi(req, res, url, connection, table, parts) {
  if (parts.length === 0) {
    if (req.method === 'GET') {
      const limit = clampInteger(url.searchParams.get('limit'), 25, 1, 200);
      const offset = clampInteger(url.searchParams.get('offset'), 0, 0, 1000000000);
      const search = url.searchParams.get('q') || '';
      const sort = url.searchParams.get('sort') || '';
      const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
      const [schemaData, rowsResults, countData] = await Promise.all([
        describeTable(connection, table),
        selectRows(connection, table, { limit, offset, search, sort, dir }),
        countRows(connection, table, search)
      ]);
      const messages = [
        ...collectMessages(schemaData.results),
        ...collectMessages(rowsResults),
        ...collectMessages(countData.results)
      ];
      return sendJson(res, 200, {
        fields: schemaData.fields,
        rows: rowsResults[0]?.data || [],
        results: rowsResults,
        total: countData.total,
        messages
      });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const values = body.values && typeof body.values === 'object' ? body.values : body;
      await requireRealtimeTableForApi(connection, table, 'Insert row');
      const { results: schemaResults, fields } = await describeTable(connection, table);
      if (hasResultErrors(schemaResults)) {
        return sendJson(res, 400, { error: 'Could not read schema', messages: collectMessages(schemaResults), results: schemaResults });
      }
      const result = await insertDocument(connection, table, fields, values);
      const messages = collectJsonMessages(result);
      return sendJson(res, messages.some((message) => message.type === 'error') ? 400 : 201, { result, messages });
    }

    return methodNotAllowed(res);
  }

  const rowId = parts[0];

  if (parts.length === 1) {
    if (req.method === 'GET') {
      const results = await selectRowById(connection, table, rowId);
      return sendJson(res, 200, { row: results[0]?.data?.[0] || null, results, messages: collectMessages(results) });
    }

    if (req.method === 'PUT') {
      const body = await readJson(req);
      const values = body.values && typeof body.values === 'object' ? body.values : body;
      await requireRealtimeTableForApi(connection, table, 'Edit row');
      const { results: schemaResults, fields } = await describeTable(connection, table);
      if (hasResultErrors(schemaResults)) {
        return sendJson(res, 400, { error: 'Could not read schema', messages: collectMessages(schemaResults), results: schemaResults });
      }
      const result = await replaceDocument(connection, table, rowId, fields, values);
      const messages = collectJsonMessages(result);
      return sendJson(res, messages.some((message) => message.type === 'error') ? 400 : 200, { result, messages });
    }

    if (req.method === 'DELETE') {
      await requireRealtimeTableForApi(connection, table, 'Delete row');
      const results = await runSql(connection, buildDeleteSql(table, rowId));
      return sendJson(res, hasResultErrors(results) ? 400 : 200, { results, messages: collectMessages(results) });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function requireRealtimeTableForApi(connection, table, action) {
  const { tables, results } = await listTables(connection);
  const messages = collectMessages(results);
  if (messages.some((message) => message.type === 'error')) {
    throw Object.assign(new Error(messages.map((message) => message.message).join('\n')), { statusCode: 502 });
  }
  const tableMeta = findTable(tables, table);
  if (!tableMeta) throw Object.assign(new Error('Table not found'), { statusCode: 404 });
  requireRealtimeTable(tableMeta, action);
  return tableMeta;
}

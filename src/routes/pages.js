import {
  buildDeleteSql,
  buildInsertSql,
  buildReplaceSql,
  collectMessages,
  countRows,
  describeTable,
  hasResultErrors,
  listTables,
  runSql,
  selectRowById,
  selectRows,
  showTableStatus
} from '../manticore.js';
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection
} from '../db.js';
import { createLoginSession, destroyRequestSession, expiredSessionCookie, verifyAdminPassword } from '../auth.js';
import { clampInteger, pathParts, readForm, redirect, sendHtml } from '../router.js';
import { layout } from '../views/layout.js';
import { renderBrowsePage, renderConnectionPage, renderRowEditPage } from '../views/browse.js';
import { renderConsolePage } from '../views/console.js';
import { renderDashboardPage, renderEditConnectionPage } from '../views/dashboard.js';
import { renderLoginPage } from '../views/login.js';
import { renderOperationPage } from '../views/components.js';

export async function handleLogin(req, res) {
  if (req.method === 'GET') {
    return sendHtml(res, 200, renderLoginPage());
  }
  if (req.method !== 'POST') {
    return sendHtml(res, 405, renderLoginPage({ error: 'Method not allowed' }));
  }

  const form = await readForm(req);
  if (!verifyAdminPassword(form.password)) {
    return sendHtml(res, 401, renderLoginPage({ error: 'Invalid password' }));
  }

  redirect(res, '/', 303, { 'Set-Cookie': createLoginSession(req) });
}

export async function handlePages(req, res, url) {
  const parts = pathParts(url.pathname);

  try {
    if (req.method === 'POST' && url.pathname === '/logout') {
      destroyRequestSession(req);
      return redirect(res, '/login', 303, { 'Set-Cookie': expiredSessionCookie() });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, renderDashboardPage({ connections: listConnections() }));
    }

    if (parts[0] === 'connections') {
      return handleConnectionPages(req, res, url, parts.slice(1));
    }

    return sendHtml(res, 404, layout({ title: 'Not found', body: '<section class="panel"><h1>Not found</h1></section>' }));
  } catch (error) {
    return sendHtml(res, error.statusCode || 500, layout({
      title: 'Error',
      body: `<section class="panel narrow"><h1>Error</h1><p>${escapeForError(error.message)}</p></section>`
    }));
  }
}

async function handleConnectionPages(req, res, url, parts) {
  if (parts.length === 0 && req.method === 'POST') {
    const form = await readForm(req);
    try {
      const connection = createConnection(form);
      return redirect(res, `/connections/${connection.id}`);
    } catch (error) {
      return sendHtml(res, 400, renderDashboardPage({ connections: listConnections(), error: error.message }));
    }
  }

  const id = Number.parseInt(parts[0], 10);
  const connection = getConnection(id);
  if (!connection) {
    return sendHtml(res, 404, layout({ title: 'Connection not found', body: '<section class="panel"><h1>Connection not found</h1></section>' }));
  }

  if (parts.length === 1 && req.method === 'GET') {
    return renderConnectionHome(res, connection);
  }

  if (parts.length === 2 && parts[1] === 'edit') {
    if (req.method === 'GET') {
      return sendHtml(res, 200, renderEditConnectionPage({ connection }));
    }
    if (req.method === 'POST') {
      const form = await readForm(req);
      try {
        updateConnection(id, form);
        return redirect(res, '/');
      } catch (error) {
        return sendHtml(res, 400, renderEditConnectionPage({ connection, error: error.message }));
      }
    }
  }

  if (parts.length === 2 && parts[1] === 'delete' && req.method === 'POST') {
    deleteConnection(id);
    return redirect(res, '/');
  }

  if (parts.length === 2 && parts[1] === 'console' && req.method === 'GET') {
    return sendHtml(res, 200, renderConsolePage({ connection }));
  }

  if (parts[1] === 'tables') {
    return handleTablePages(req, res, url, connection, parts.slice(2));
  }

  return sendHtml(res, 404, layout({ title: 'Not found', body: '<section class="panel"><h1>Not found</h1></section>' }));
}

async function renderConnectionHome(res, connection) {
  try {
    const { results, tables } = await listTables(connection);
    return sendHtml(res, 200, renderConnectionPage({
      connection,
      tables,
      messages: collectMessages(results)
    }));
  } catch (error) {
    return sendHtml(res, 502, renderConnectionPage({ connection, error: error.message }));
  }
}

async function handleTablePages(req, res, url, connection, parts) {
  const table = parts[0];
  if (!table) return renderConnectionHome(res, connection);

  if (parts.length === 1 && req.method === 'GET') {
    return renderBrowse(req, res, url, connection, table);
  }

  if (parts.length === 2 && parts[1] === 'new') {
    if (req.method === 'GET') return renderInsertForm(res, connection, table);
    if (req.method === 'POST') return handleInsertRow(req, res, connection, table);
  }

  if (parts.length === 4 && parts[1] === 'rows' && parts[3] === 'edit') {
    if (req.method === 'GET') return renderEditForm(res, connection, table, parts[2]);
    if (req.method === 'POST') return handleEditRow(req, res, connection, table, parts[2]);
  }

  if (parts.length === 4 && parts[1] === 'rows' && parts[3] === 'delete' && req.method === 'POST') {
    return handleDeleteRow(res, connection, table, parts[2]);
  }

  return sendHtml(res, 404, layout({ title: 'Not found', body: '<section class="panel"><h1>Not found</h1></section>' }));
}

async function renderBrowse(req, res, url, connection, table) {
  const page = clampInteger(url.searchParams.get('page'), 1, 1, 1000000);
  const perPage = clampInteger(url.searchParams.get('perPage'), 25, 1, 200);
  const offset = (page - 1) * perPage;
  const search = url.searchParams.get('q') || '';
  const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
  let sort = url.searchParams.get('sort') || '';

  try {
    const tablesData = await listTables(connection);
    const schemaData = await describeTable(connection, table);
    const validFields = new Set(schemaData.fields.map((field) => field.name));
    if (sort && !validFields.has(sort)) sort = '';

    const [statusResults, rowsResults, countData] = await Promise.all([
      showTableStatus(connection, table),
      selectRows(connection, table, { limit: perPage, offset, search, sort, dir }),
      countRows(connection, table, search)
    ]);

    const messages = [
      ...collectMessages(tablesData.results),
      ...collectMessages(schemaData.results),
      ...collectMessages(statusResults),
      ...collectMessages(rowsResults),
      ...collectMessages(countData.results)
    ];

    return sendHtml(res, 200, renderBrowsePage({
      connection,
      table,
      tables: tablesData.tables,
      schema: schemaData.fields,
      statusResult: statusResults,
      rowsResult: rowsResults[0],
      total: countData.total,
      page,
      perPage,
      search,
      sort,
      dir,
      messages
    }));
  } catch (error) {
    return sendHtml(res, 502, renderBrowsePage({ connection, table, error: error.message }));
  }
}

async function renderInsertForm(res, connection, table, values = {}, error = '') {
  const schemaData = await describeTable(connection, table);
  return sendHtml(res, hasResultErrors(schemaData.results) ? 400 : 200, renderRowEditPage({
    connection,
    table,
    fields: schemaData.fields,
    values,
    mode: 'insert',
    error: error || collectMessages(schemaData.results).map((message) => message.message).join('\n')
  }));
}

async function renderEditForm(res, connection, table, rowId, error = '') {
  const [schemaData, rowResults] = await Promise.all([
    describeTable(connection, table),
    selectRowById(connection, table, rowId)
  ]);
  const row = rowResults[0]?.data?.[0] || { id: rowId };
  const messages = [...collectMessages(schemaData.results), ...collectMessages(rowResults)];
  const messageError = messages.map((message) => message.message).join('\n');
  return sendHtml(res, hasResultErrors(schemaData.results) || hasResultErrors(rowResults) ? 400 : 200, renderRowEditPage({
    connection,
    table,
    fields: schemaData.fields,
    values: row,
    mode: 'edit',
    error: error || messageError || (!rowResults[0]?.data?.[0] ? 'Row not found' : '')
  }));
}

function valuesFromForm(fields, form) {
  const values = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(form, field.name)) {
      values[field.name] = form[field.name];
    }
  }
  return values;
}

async function handleInsertRow(req, res, connection, table) {
  const form = await readForm(req);
  const schemaData = await describeTable(connection, table);
  if (hasResultErrors(schemaData.results)) {
    return renderInsertForm(res, connection, table, form, collectMessages(schemaData.results).map((message) => message.message).join('\n'));
  }

  const values = valuesFromForm(schemaData.fields, form);
  try {
    const results = await runSql(connection, buildInsertSql(table, schemaData.fields, values));
    if (collectMessages(results).length) {
      return renderWriteResult(res, connection, table, 'Insert result', results);
    }
    return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
  } catch (error) {
    return renderInsertForm(res, connection, table, form, error.message);
  }
}

async function handleEditRow(req, res, connection, table, rowId) {
  const form = await readForm(req);
  const schemaData = await describeTable(connection, table);
  if (hasResultErrors(schemaData.results)) {
    return renderEditForm(res, connection, table, rowId, collectMessages(schemaData.results).map((message) => message.message).join('\n'));
  }

  const values = valuesFromForm(schemaData.fields, form);
  try {
    const results = await runSql(connection, buildReplaceSql(table, rowId, schemaData.fields, values));
    if (collectMessages(results).length) {
      return renderWriteResult(res, connection, table, 'Edit result', results);
    }
    return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
  } catch (error) {
    return renderEditForm(res, connection, table, rowId, error.message);
  }
}

async function handleDeleteRow(res, connection, table, rowId) {
  try {
    const results = await runSql(connection, buildDeleteSql(table, rowId));
    if (collectMessages(results).length) {
      return renderWriteResult(res, connection, table, 'Delete result', results);
    }
    return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
  } catch (error) {
    return sendHtml(res, 400, layout({
      title: 'Delete failed',
      body: renderOperationPage({
        title: 'Delete failed',
        message: error.message,
        backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
      })
    }));
  }
}

function renderWriteResult(res, connection, table, title, results) {
  const messages = collectMessages(results);
  return sendHtml(res, hasResultErrors(results) ? 400 : 200, layout({
    title,
    body: renderOperationPage({
      title,
      messages,
      backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
    })
  }));
}

function escapeForError(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

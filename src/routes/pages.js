import {
  attributeFields,
  buildAlterAddColumnSql,
  buildAlterDropColumnSql,
  buildAlterModifyBigintSql,
  buildDeleteSql,
  buildCreateTableSql,
  buildDropTableSql,
  buildTruncateTableSql,
  collectJsonMessages,
  collectMessages,
  countRows,
  describeTable,
  findTable,
  hasResultErrors,
  insertDocument,
  listTables,
  replaceDocument,
  requireRealtimeTable,
  runSql,
  selectRowById,
  selectRows,
  showCreateTable,
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
import { renderBrowsePage, renderConnectionPage, renderCreateTablePage, renderRowEditPage } from '../views/browse.js';
import { renderConsolePage } from '../views/console.js';
import { renderDashboardPage, renderEditConnectionPage } from '../views/dashboard.js';
import { renderLoginPage } from '../views/login.js';
import { renderOperationPage, renderSqlPreviewForm } from '../views/components.js';

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

  if (parts.length === 2 && parts[1] === 'new-table') {
    if (req.method === 'GET') return renderCreateTableForm(res, connection);
    if (req.method === 'POST') return handleCreateTable(req, res, connection);
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

  if (parts.length === 2 && parts[1] === 'drop') {
    if (req.method === 'GET') return renderTableSqlPreview(res, connection, table, 'Drop table', buildDropTableSql(table), {
      submitLabel: 'Drop table',
      destructive: true
    });
    if (req.method === 'POST') return handleRunTableSql(req, res, connection, table, buildDropTableSql(table), {
      successRedirect: `/connections/${connection.id}`,
      title: 'Drop table'
    });
  }

  if (parts.length === 2 && parts[1] === 'truncate') {
    if (req.method === 'GET') return renderTableSqlPreview(res, connection, table, 'Truncate table', buildTruncateTableSql(table), {
      submitLabel: 'Truncate table',
      destructive: true
    });
    if (req.method === 'POST') return handleRunTableSql(req, res, connection, table, buildTruncateTableSql(table), {
      successRedirect: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`,
      title: 'Truncate table'
    });
  }

  if (parts.length === 3 && parts[1] === 'columns' && parts[2] === 'add' && req.method === 'POST') {
    return handleAddColumn(req, res, connection, table);
  }

  if (parts.length === 4 && parts[1] === 'columns' && parts[3] === 'drop') {
    if (req.method === 'GET') return renderDropColumnPreview(res, connection, table, parts[2]);
    if (req.method === 'POST') return handleDropColumn(req, res, connection, table, parts[2]);
  }

  if (parts.length === 4 && parts[1] === 'columns' && parts[3] === 'modify-bigint') {
    if (req.method === 'GET') return renderModifyColumnPreview(res, connection, table, parts[2]);
    if (req.method === 'POST') return handleModifyColumn(req, res, connection, table, parts[2]);
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
    return handleDeleteRow(req, res, connection, table, parts[2]);
  }

  if (parts.length === 4 && parts[1] === 'rows' && parts[3] === 'delete' && req.method === 'GET') {
    return renderDeleteRowPreview(res, connection, table, parts[2]);
  }

  return sendHtml(res, 404, layout({ title: 'Not found', body: '<section class="panel"><h1>Not found</h1></section>' }));
}

async function renderBrowse(req, res, url, connection, table) {
  let page = clampInteger(url.searchParams.get('page'), 1, 1, 1000000);
  const perPage = clampInteger(url.searchParams.get('perPage'), 25, 1, 200);
  const search = url.searchParams.get('q') || '';
  const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
  let sort = url.searchParams.get('sort') || '';

  try {
    const tablesData = await listTables(connection);
    const schemaData = await describeTable(connection, table);
    const tableMeta = findTable(tablesData.tables, table);
    const validFields = new Set(schemaData.fields.map((field) => field.name));
    if (sort && !validFields.has(sort)) sort = '';

    // Resolve the row count first so the requested page can be clamped to the
    // last real page (avoids "Page 999 of 2" and an offset past the last row).
    const countData = await countRows(connection, table, search);
    const maxPage = Math.max(1, Math.ceil(countData.total / perPage));
    if (page > maxPage) page = maxPage;
    const offset = (page - 1) * perPage;

    const [statusResults, rowsResults, showCreateData] = await Promise.all([
      showTableStatus(connection, table),
      selectRows(connection, table, { limit: perPage, offset, search, sort, dir }),
      showCreateTable(connection, table)
    ]);

    const messages = [
      ...collectMessages(tablesData.results),
      ...collectMessages(schemaData.results),
      ...collectMessages(statusResults),
      ...collectMessages(rowsResults),
      ...collectMessages(countData.results),
      ...collectMessages(showCreateData.results)
    ];

    return sendHtml(res, 200, renderBrowsePage({
      connection,
      table,
      tables: tablesData.tables,
      tableMeta,
      schema: schemaData.fields,
      statusResult: statusResults,
      rowsResult: rowsResults[0],
      total: countData.total,
      page,
      perPage,
      search,
      sort,
      dir,
      showCreateStatement: showCreateData.statement,
      messages
    }));
  } catch (error) {
    return sendHtml(res, 502, renderBrowsePage({ connection, table, error: error.message }));
  }
}

async function renderCreateTableForm(res, connection, values = {}, previewSql = '', showExecute = false, error = '') {
  return sendHtml(res, error ? 400 : 200, renderCreateTablePage({
    connection,
    values,
    previewSql,
    showExecute,
    error
  }));
}

async function handleCreateTable(req, res, connection) {
  const form = await readForm(req);
  let sql = '';
  try {
    sql = buildCreateTableSql(form);
    if (form.intent === 'execute') {
      if (!samePreviewSql(form.sql_preview, sql)) {
        return renderCreateTableForm(res, connection, form, sql, true, 'Review the updated SQL preview before creating the table.');
      }
      const results = await runSql(connection, sql);
      if (collectMessages(results).length) {
        return renderWriteResult(res, connection, form.table_name || '', 'Create table result', results, `/connections/${connection.id}`);
      }
      return redirect(res, `/connections/${connection.id}`);
    }
    return renderCreateTableForm(res, connection, form, sql, true);
  } catch (error) {
    return renderCreateTableForm(res, connection, form, sql, false, error.message);
  }
}

async function loadTableContext(connection, table, action) {
  const [tablesData, schemaData] = await Promise.all([
    listTables(connection),
    describeTable(connection, table)
  ]);
  const tableMeta = findTable(tablesData.tables, table);
  if (!tableMeta) throw Object.assign(new Error(`Table ${table} not found`), { statusCode: 404 });
  requireRealtimeTable(tableMeta, action);
  if (hasResultErrors(schemaData.results)) {
    throw new Error(collectMessages(schemaData.results).map((message) => message.message).join('\n') || 'Could not read schema');
  }
  return { tableMeta, fields: schemaData.fields, tablesData, schemaData };
}

async function renderTableSqlPreview(res, connection, table, title, sql, options = {}) {
  try {
    await loadTableContext(connection, table, title);
    return sendHtml(res, 200, layout({
      title,
      body: renderSqlPreviewForm({
        title,
        sql,
        action: `/connections/${connection.id}/tables/${encodeURIComponent(table)}/${title.toLowerCase().startsWith('drop') ? 'drop' : 'truncate'}`,
        submitLabel: options.submitLabel || 'Run',
        destructive: Boolean(options.destructive),
        backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
      })
    }));
  } catch (error) {
    return renderTableActionError(res, connection, table, title, error.message);
  }
}

async function handleRunTableSql(req, res, connection, table, sql, options = {}) {
  const form = await readForm(req);
  if (!samePreviewSql(form.sql_preview, sql)) {
    return renderTableSqlPreview(res, connection, table, options.title || 'Table action', sql, {
      submitLabel: options.title || 'Run',
      destructive: true
    });
  }
  try {
    await loadTableContext(connection, table, options.title || 'Table action');
    const results = await runSql(connection, sql);
    if (collectMessages(results).length) {
      return renderWriteResult(res, connection, table, `${options.title || 'Table action'} result`, results, options.successRedirect || `/connections/${connection.id}`);
    }
    return redirect(res, options.successRedirect || `/connections/${connection.id}`);
  } catch (error) {
    return renderTableActionError(res, connection, table, options.title || 'Table action failed', error.message);
  }
}

async function handleAddColumn(req, res, connection, table) {
  const form = await readForm(req);
  try {
    const { fields } = await loadTableContext(connection, table, 'ADD COLUMN');
    if (!attributeFields(fields).length) {
      throw new Error('ADD COLUMN is not available because ALTER requires a table with at least one attribute');
    }
    const sql = buildAlterAddColumnSql(table, form);
    const action = `/connections/${connection.id}/tables/${encodeURIComponent(table)}/columns/add`;
    if (form.intent === 'execute') {
      if (!samePreviewSql(form.sql_preview, sql)) {
        return renderColumnSqlPreview(res, connection, table, 'Add column', sql, action, form, false);
      }
      const results = await runSql(connection, sql);
      if (collectMessages(results).length) {
        return renderWriteResult(res, connection, table, 'Add column result', results);
      }
      return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
    }
    return renderColumnSqlPreview(res, connection, table, 'Add column', sql, action, form, false);
  } catch (error) {
    return renderTableActionError(res, connection, table, 'Add column failed', error.message);
  }
}

async function renderDropColumnPreview(res, connection, table, column) {
  try {
    const { fields } = await loadTableContext(connection, table, 'DROP COLUMN');
    const sql = buildAlterDropColumnSql(table, column, fields);
    return renderColumnSqlPreview(
      res,
      connection,
      table,
      'Drop column',
      sql,
      `/connections/${connection.id}/tables/${encodeURIComponent(table)}/columns/${encodeURIComponent(column)}/drop`,
      {},
      true
    );
  } catch (error) {
    return renderTableActionError(res, connection, table, 'Drop column failed', error.message);
  }
}

async function handleDropColumn(req, res, connection, table, column) {
  const form = await readForm(req);
  try {
    const { fields } = await loadTableContext(connection, table, 'DROP COLUMN');
    const sql = buildAlterDropColumnSql(table, column, fields);
    if (!samePreviewSql(form.sql_preview, sql)) {
      return renderDropColumnPreview(res, connection, table, column);
    }
    const results = await runSql(connection, sql);
    if (collectMessages(results).length) return renderWriteResult(res, connection, table, 'Drop column result', results);
    return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
  } catch (error) {
    return renderTableActionError(res, connection, table, 'Drop column failed', error.message);
  }
}

async function renderModifyColumnPreview(res, connection, table, column) {
  try {
    const { fields } = await loadTableContext(connection, table, 'MODIFY COLUMN');
    const sql = buildAlterModifyBigintSql(table, column, fields);
    return renderColumnSqlPreview(
      res,
      connection,
      table,
      'Widen column',
      sql,
      `/connections/${connection.id}/tables/${encodeURIComponent(table)}/columns/${encodeURIComponent(column)}/modify-bigint`,
      {},
      false,
      'Manticore only supports int to bigint widening.'
    );
  } catch (error) {
    return renderTableActionError(res, connection, table, 'Modify column failed', error.message);
  }
}

async function handleModifyColumn(req, res, connection, table, column) {
  const form = await readForm(req);
  try {
    const { fields } = await loadTableContext(connection, table, 'MODIFY COLUMN');
    const sql = buildAlterModifyBigintSql(table, column, fields);
    if (!samePreviewSql(form.sql_preview, sql)) {
      return renderModifyColumnPreview(res, connection, table, column);
    }
    const results = await runSql(connection, sql);
    if (collectMessages(results).length) return renderWriteResult(res, connection, table, 'Modify column result', results);
    return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
  } catch (error) {
    return renderTableActionError(res, connection, table, 'Modify column failed', error.message);
  }
}

function renderColumnSqlPreview(res, connection, table, title, sql, action, hidden, destructive, message = '') {
  return sendHtml(res, 200, layout({
    title,
    body: renderSqlPreviewForm({
      title,
      sql,
      action,
      hidden,
      submitLabel: title,
      destructive,
      message,
      backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
    })
  }));
}

function renderTableActionError(res, connection, table, title, message) {
  return sendHtml(res, 400, layout({
    title,
    body: renderOperationPage({
      title,
      message,
      backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
    })
  }));
}

async function renderInsertForm(res, connection, table, values = {}, error = '') {
  try {
    const { fields } = await loadTableContext(connection, table, 'Insert row');
    return sendHtml(res, error ? 400 : 200, renderRowEditPage({
      connection,
      table,
      fields,
      values,
      mode: 'insert',
      error
    }));
  } catch (loadError) {
    return renderTableActionError(res, connection, table, 'Insert row unavailable', loadError.message);
  }
}

async function renderEditForm(res, connection, table, rowId, error = '') {
  try {
    const { fields, schemaData } = await loadTableContext(connection, table, 'Edit row');
    const rowResults = await selectRowById(connection, table, rowId);
    const row = rowResults[0]?.data?.[0] || { id: rowId };
    const messages = [...collectMessages(schemaData.results), ...collectMessages(rowResults)];
    const messageError = messages.map((message) => message.message).join('\n');
    return sendHtml(res, hasResultErrors(schemaData.results) || hasResultErrors(rowResults) ? 400 : 200, renderRowEditPage({
      connection,
      table,
      fields,
      values: row,
      mode: 'edit',
      error: error || messageError || (!rowResults[0]?.data?.[0] ? 'Row not found' : '')
    }));
  } catch (loadError) {
    return renderTableActionError(res, connection, table, 'Edit row unavailable', loadError.message);
  }
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
  try {
    const { fields } = await loadTableContext(connection, table, 'Insert row');
    const values = valuesFromForm(fields, form);
    const payload = await insertDocument(connection, table, fields, values);
    const messages = collectJsonMessages(payload);
    if (messages.length) {
      return renderJsonWriteResult(res, connection, table, 'Insert result', messages);
    }
    return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
  } catch (error) {
    return renderInsertForm(res, connection, table, form, error.message);
  }
}

async function handleEditRow(req, res, connection, table, rowId) {
  const form = await readForm(req);
  try {
    const { fields } = await loadTableContext(connection, table, 'Edit row');
    const values = valuesFromForm(fields, form);
    const payload = await replaceDocument(connection, table, rowId, fields, values);
    const messages = collectJsonMessages(payload);
    if (messages.length) {
      return renderJsonWriteResult(res, connection, table, 'Edit result', messages);
    }
    return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
  } catch (error) {
    return renderEditForm(res, connection, table, rowId, error.message);
  }
}

async function renderDeleteRowPreview(res, connection, table, rowId) {
  try {
    await loadTableContext(connection, table, 'Delete row');
    const sql = buildDeleteSql(table, rowId);
    return sendHtml(res, 200, layout({
      title: 'Delete row',
      body: renderSqlPreviewForm({
        title: 'Delete row',
        sql,
        action: `/connections/${connection.id}/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(rowId)}/delete`,
        submitLabel: 'Delete row',
        destructive: true,
        backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
      })
    }));
  } catch (error) {
    return renderTableActionError(res, connection, table, 'Delete row unavailable', error.message);
  }
}

async function handleDeleteRow(req, res, connection, table, rowId) {
  const form = await readForm(req);
  try {
    await loadTableContext(connection, table, 'Delete row');
    const sql = buildDeleteSql(table, rowId);
    if (!samePreviewSql(form.sql_preview, sql)) {
      return renderDeleteRowPreview(res, connection, table, rowId);
    }
    const results = await runSql(connection, sql);
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

function renderWriteResult(res, connection, table, title, results, backHref = '') {
  const messages = collectMessages(results);
  return sendHtml(res, hasResultErrors(results) ? 400 : 200, layout({
    title,
    body: renderOperationPage({
      title,
      messages,
      backHref: backHref || `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
    })
  }));
}

function renderJsonWriteResult(res, connection, table, title, messages) {
  return sendHtml(res, messages.some((message) => message.type === 'error') ? 400 : 200, layout({
    title,
    body: renderOperationPage({
      title,
      messages,
      backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
    })
  }));
}

function samePreviewSql(submitted, expected) {
  return normalizePreviewSql(submitted) === normalizePreviewSql(expected);
}

function normalizePreviewSql(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
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

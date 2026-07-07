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
  maxBrowseWindow,
  ping,
  replaceDocument,
  requireRealtimeTable,
  runSql,
  runSqlStatements,
  selectRowById,
  selectRows,
  showCreateTable,
  showTableStatus,
  splitSqlStatements
} from '../manticore.js';
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection
} from '../db.js';
import { createLoginSession, destroyRequestSession, expiredSessionCookie, verifyAdminPassword } from '../auth.js';
import { clampInteger, htmxTarget, isHtmx, pathParts, readForm, redirect, sendHtml } from '../router.js';
import { escapeHtml } from '../html.js';
import { fragment, layout } from '../views/layout.js';
import {
  renderBrowseDataPanel,
  renderBrowsePage,
  renderConnectionPage,
  renderCreateTablePage,
  renderRowEditPage
} from '../views/browse.js';
import { renderConsolePage, renderConsoleResults } from '../views/console.js';
import { renderDashboardPage, renderEditConnectionPage } from '../views/dashboard.js';
import { renderLoginPage } from '../views/login.js';
import { renderOperationPage, renderSqlPreviewForm, renderToastsOob } from '../views/components.js';

// The same URL answers both ways: a full page for direct loads and a fragment
// for htmx requests, so every screen stays deep-linkable and refreshable.
const pageHeaders = { Vary: 'HX-Request, HX-Target' };

// views are { title, body }. For htmx requests this sends the #main fragment
// (plus <title> and out-of-band toasts); pushUrl updates the address bar after
// successful POSTs (the non-htmx path keeps its 303 redirect instead).
function respond(req, res, status, view, { pushUrl, toasts = [] } = {}) {
  if (isHtmx(req)) {
    const headers = { ...pageHeaders };
    if (pushUrl) headers['HX-Push-Url'] = pushUrl;
    return sendHtml(res, status, fragment({ ...view, toasts }), headers);
  }
  return sendHtml(res, status, layout(view), pageHeaders);
}

// Failures that are not a form re-render keep the current content on screen:
// the body carries only out-of-band toasts, HX-Reswap:none skips the main swap
// and HX-Push-Url:false stops the URL from moving to a page that never loaded.
function respondToastError(res, status, messages) {
  const list = Array.isArray(messages) ? messages : [{ type: 'error', message: String(messages) }];
  const toasts = list.map((entry) => (typeof entry === 'string' ? { type: 'error', message: entry } : entry));
  return sendHtml(res, status, renderToastsOob(toasts), {
    ...pageHeaders,
    'HX-Reswap': 'none',
    'HX-Push-Url': 'false'
  });
}

function respondNotFound(req, res, message = 'Not found') {
  if (isHtmx(req)) return respondToastError(res, 404, message);
  return sendHtml(res, 404, layout({
    title: message,
    body: `<section class="panel"><h1>${escapeHtml(message)}</h1></section>`
  }), pageHeaders);
}

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
      return respond(req, res, 200, renderDashboardPage({ connections: listConnections() }));
    }

    if (parts[0] === 'connections') {
      return await handleConnectionPages(req, res, url, parts.slice(1));
    }

    return respondNotFound(req, res);
  } catch (error) {
    const status = error.statusCode || 500;
    if (isHtmx(req)) {
      return respondToastError(res, status, error.message || 'Internal server error');
    }
    return sendHtml(res, status, layout({
      title: 'Error',
      body: `<section class="panel narrow"><h1>Error</h1><p>${escapeHtml(error.message || 'Internal server error')}</p></section>`
    }), pageHeaders);
  }
}

async function handleConnectionPages(req, res, url, parts) {
  if (parts.length === 0 && req.method === 'POST') {
    const form = await readForm(req);
    try {
      const connection = createConnection(form);
      if (isHtmx(req)) {
        return respondConnectionHome(req, res, connection, {
          pushUrl: `/connections/${connection.id}`,
          toasts: [{ type: 'success', message: 'Connection saved' }]
        });
      }
      return redirect(res, `/connections/${connection.id}`);
    } catch (error) {
      return respond(req, res, 400, renderDashboardPage({ connections: listConnections(), error: error.message, values: form }));
    }
  }

  const id = Number.parseInt(parts[0], 10);
  const connection = getConnection(id);
  if (!connection) {
    return respondNotFound(req, res, 'Connection not found');
  }

  if (parts.length === 1 && req.method === 'GET') {
    return respondConnectionHome(req, res, connection);
  }

  if (parts.length === 2 && parts[1] === 'edit') {
    if (req.method === 'GET') {
      return respond(req, res, 200, renderEditConnectionPage({ connection }));
    }
    if (req.method === 'POST') {
      const form = await readForm(req);
      try {
        updateConnection(id, form);
        if (isHtmx(req)) {
          return respond(req, res, 200, renderDashboardPage({ connections: listConnections() }), {
            pushUrl: '/',
            toasts: [{ type: 'success', message: 'Connection updated' }]
          });
        }
        return redirect(res, '/');
      } catch (error) {
        // Re-render with what the user typed, not the stored row, so a typo in
        // one field does not wipe the rest of their edits. Secrets are safe to
        // spread: the form never echoes password/bearer_token values back.
        return respond(req, res, 400, renderEditConnectionPage({
          connection: { ...connection, ...form, id: connection.id },
          error: error.message
        }));
      }
    }
  }

  if (parts.length === 2 && parts[1] === 'delete' && req.method === 'POST') {
    deleteConnection(id);
    if (isHtmx(req)) {
      return respond(req, res, 200, renderDashboardPage({ connections: listConnections() }), {
        pushUrl: '/',
        toasts: [{ type: 'success', message: 'Connection deleted' }]
      });
    }
    return redirect(res, '/');
  }

  if (parts.length === 2 && parts[1] === 'test' && req.method === 'POST') {
    return handleTestConnection(req, res, connection);
  }

  if (parts.length === 2 && parts[1] === 'console') {
    if (req.method === 'GET') {
      return respond(req, res, 200, renderConsolePage({ connection }));
    }
    if (req.method === 'POST') {
      return handleConsoleRun(req, res, connection);
    }
  }

  if (parts.length === 2 && parts[1] === 'new-table') {
    if (req.method === 'GET') return renderCreateTableForm(req, res, connection);
    if (req.method === 'POST') return handleCreateTable(req, res, connection);
  }

  if (parts[1] === 'tables') {
    return handleTablePages(req, res, url, connection, parts.slice(2));
  }

  return respondNotFound(req, res);
}

async function respondConnectionHome(req, res, connection, { pushUrl, toasts = [] } = {}) {
  try {
    const { results, tables } = await listTables(connection);
    return respond(req, res, 200, renderConnectionPage({
      connection,
      tables,
      messages: collectMessages(results)
    }), { pushUrl, toasts });
  } catch (error) {
    // Still a navigable destination: the connection page renders with an
    // inline error and working links, mirroring the non-htmx behaviour.
    return respond(req, res, 502, renderConnectionPage({ connection, error: error.message }), { pushUrl, toasts });
  }
}

async function handleTestConnection(req, res, connection) {
  if (!isHtmx(req)) return redirect(res, '/');
  try {
    const results = await ping(connection);
    const failed = hasResultErrors(results);
    const text = failed
      ? (collectMessages(results).map((message) => `${message.statement ? `Statement ${message.statement}: ` : ''}${message.message}`).join('\n') || 'Connection test failed')
      : '✓ Connected';
    return sendHtml(res, failed ? 502 : 200, renderTestOutput(connection.id, failed, text), pageHeaders);
  } catch (error) {
    return sendHtml(res, 502, renderTestOutput(connection.id, true, error.message), pageHeaders);
  }
}

function renderTestOutput(id, failed, text) {
  return `<p class="test-output ${failed ? 'error-text' : 'success-text'}" id="test-output-${id}">${escapeHtml(text)}</p>`;
}

async function handleConsoleRun(req, res, connection) {
  const form = await readForm(req);
  const sql = String(form.sql || '');
  // /sql?mode=raw only takes one statement per request, so pasted scripts are
  // split and submitted statement by statement (§4.1).
  const statements = splitSqlStatements(sql);

  if (!statements.length) {
    if (isHtmx(req)) return sendHtml(res, 400, renderConsoleResults({ error: 'SQL is required' }), pageHeaders);
    return respond(req, res, 400, renderConsolePage({ connection, sql, error: 'SQL is required' }));
  }

  try {
    const { results, skipped } = await runSqlStatements(connection, statements);
    const notice = skipped > 0
      ? `Stopped after a statement failed; ${skipped} later statement${skipped === 1 ? '' : 's'} did not run.`
      : '';
    if (isHtmx(req)) return sendHtml(res, 200, renderConsoleResults({ results, notice }), pageHeaders);
    return respond(req, res, 200, renderConsolePage({ connection, sql, results, notice }));
  } catch (error) {
    const status = error.statusCode || 502;
    if (isHtmx(req)) return sendHtml(res, status, renderConsoleResults({ error: error.message }), pageHeaders);
    return respond(req, res, status, renderConsolePage({ connection, sql, error: error.message }));
  }
}

function queryFromUrl(url) {
  return {
    page: url.searchParams.get('page'),
    perPage: url.searchParams.get('perPage'),
    q: url.searchParams.get('q') || '',
    sort: url.searchParams.get('sort') || '',
    dir: url.searchParams.get('dir')
  };
}

async function handleTablePages(req, res, url, connection, parts) {
  const table = parts[0];
  if (!table) return respondConnectionHome(req, res, connection);

  if (parts.length === 1 && req.method === 'GET') {
    return renderBrowse(req, res, connection, table, queryFromUrl(url));
  }

  if (parts.length === 2 && parts[1] === 'drop') {
    if (req.method === 'GET') {
      return renderTableSqlPreview(req, res, connection, table, 'Drop table', buildDropTableSql(table), {
        submitLabel: 'Drop table',
        destructive: true
      });
    }
    if (req.method === 'POST') {
      return handleRunTableSql(req, res, connection, table, buildDropTableSql(table), {
        title: 'Drop table',
        successMessage: 'Table dropped',
        destination: 'connection',
        backHref: `/connections/${connection.id}`
      });
    }
  }

  if (parts.length === 2 && parts[1] === 'truncate') {
    if (req.method === 'GET') {
      return renderTableSqlPreview(req, res, connection, table, 'Truncate table', buildTruncateTableSql(table), {
        submitLabel: 'Truncate table',
        destructive: true
      });
    }
    if (req.method === 'POST') {
      return handleRunTableSql(req, res, connection, table, buildTruncateTableSql(table), {
        title: 'Truncate table',
        successMessage: 'Table truncated',
        destination: 'browse'
      });
    }
  }

  if (parts.length === 3 && parts[1] === 'columns' && parts[2] === 'add' && req.method === 'POST') {
    return handleAddColumn(req, res, connection, table);
  }

  if (parts.length === 4 && parts[1] === 'columns' && parts[3] === 'drop') {
    if (req.method === 'GET') return renderDropColumnPreview(req, res, connection, table, parts[2]);
    if (req.method === 'POST') return handleDropColumn(req, res, connection, table, parts[2]);
  }

  if (parts.length === 4 && parts[1] === 'columns' && parts[3] === 'modify-bigint') {
    if (req.method === 'GET') return renderModifyColumnPreview(req, res, connection, table, parts[2]);
    if (req.method === 'POST') return handleModifyColumn(req, res, connection, table, parts[2]);
  }

  if (parts.length === 2 && parts[1] === 'new') {
    if (req.method === 'GET') return renderInsertForm(req, res, connection, table);
    if (req.method === 'POST') return handleInsertRow(req, res, connection, table);
  }

  if (parts.length === 4 && parts[1] === 'rows' && parts[3] === 'edit') {
    if (req.method === 'GET') return renderEditForm(req, res, connection, table, parts[2]);
    if (req.method === 'POST') return handleEditRow(req, res, connection, table, parts[2]);
  }

  if (parts.length === 4 && parts[1] === 'rows' && parts[3] === 'delete') {
    if (req.method === 'GET') return renderDeleteRowPreview(req, res, connection, table, parts[2]);
    if (req.method === 'POST') return handleDeleteRow(req, res, connection, table, parts[2]);
  }

  return respondNotFound(req, res);
}

async function renderBrowse(req, res, connection, table, query, extras = {}) {
  let page = clampInteger(query.page, 1, 1, 1000000);
  const perPage = clampInteger(query.perPage, 25, 1, 200);
  const search = query.q || '';
  const dir = query.dir === 'desc' ? 'desc' : 'asc';
  let sort = query.sort || '';

  try {
    const tablesData = await listTables(connection);
    const schemaData = await describeTable(connection, table);
    const tableMeta = findTable(tablesData.tables, table);
    const validFields = new Set(schemaData.fields.map((field) => field.name));
    if (sort && !validFields.has(sort)) sort = '';

    // Resolve the row count first so the requested page can be clamped to the
    // last real page (avoids "Page 999 of 2" and an offset past the last row).
    // The browse window cap keeps pagination from ever requesting an offset
    // whose OPTION max_matches could exhaust the node's memory (§4.2).
    const countData = await countRows(connection, table, search);
    const maxPage = Math.max(1, Math.min(
      Math.ceil(countData.total / perPage),
      Math.floor(maxBrowseWindow / perPage)
    ));
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

    // Search / sort / pagination swap only the data panel; any Manticore
    // messages go to the shared toast region since the inline message area
    // above the grid is not part of this fragment.
    if (isHtmx(req) && htmxTarget(req) === 'data-panel') {
      const canWrite = (tableMeta?.type || '') === 'rt';
      const panel = renderBrowseDataPanel({
        connection,
        table,
        rowsResult: rowsResults[0],
        total: countData.total,
        page,
        perPage,
        search,
        sort,
        dir,
        canWrite
      });
      return sendHtml(res, 200, renderToastsOob(messages) + panel, pageHeaders);
    }

    return respond(req, res, 200, renderBrowsePage({
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
    }), extras);
  } catch (error) {
    if (isHtmx(req)) {
      // Keep the grid and whatever the user typed; explain in the toast region.
      return respondToastError(res, error.statusCode || 502, [
        ...(extras.toasts || []),
        { type: 'error', message: error.message }
      ]);
    }
    return respond(req, res, 502, renderBrowsePage({ connection, table, error: error.message }));
  }
}

// Shared success landing for row/column/table actions that return to browse.
function browseSuccess(req, res, connection, table, message) {
  if (isHtmx(req)) {
    return renderBrowse(req, res, connection, table, {}, {
      pushUrl: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`,
      toasts: [{ type: 'success', message }]
    });
  }
  return redirect(res, `/connections/${connection.id}/tables/${encodeURIComponent(table)}`);
}

async function renderCreateTableForm(req, res, connection, values = {}, previewSql = '', showExecute = false, error = '') {
  return respond(req, res, error ? 400 : 200, renderCreateTablePage({
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
        return renderCreateTableForm(req, res, connection, form, sql, true, 'Review the updated SQL preview before creating the table.');
      }
      const results = await runSql(connection, sql);
      if (collectMessages(results).length) {
        return renderWriteResult(req, res, connection, form.table_name || '', 'Create table result', results, `/connections/${connection.id}`);
      }
      if (isHtmx(req)) {
        return respondConnectionHome(req, res, connection, {
          pushUrl: `/connections/${connection.id}`,
          toasts: [{ type: 'success', message: 'Table created' }]
        });
      }
      return redirect(res, `/connections/${connection.id}`);
    }
    return renderCreateTableForm(req, res, connection, form, sql, true);
  } catch (error) {
    return renderCreateTableForm(req, res, connection, form, sql, false, error.message);
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

async function renderTableSqlPreview(req, res, connection, table, title, sql, options = {}) {
  try {
    await loadTableContext(connection, table, title);
    return respond(req, res, 200, {
      title,
      body: renderSqlPreviewForm({
        title,
        sql,
        action: `/connections/${connection.id}/tables/${encodeURIComponent(table)}/${title.toLowerCase().startsWith('drop') ? 'drop' : 'truncate'}`,
        submitLabel: options.submitLabel || 'Run',
        destructive: Boolean(options.destructive),
        backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
      })
    });
  } catch (error) {
    return renderTableActionError(req, res, connection, table, title, error.message);
  }
}

async function handleRunTableSql(req, res, connection, table, sql, options = {}) {
  const form = await readForm(req);
  if (!samePreviewSql(form.sql_preview, sql)) {
    return renderTableSqlPreview(req, res, connection, table, options.title || 'Table action', sql, {
      submitLabel: options.title || 'Run',
      destructive: true
    });
  }
  try {
    await loadTableContext(connection, table, options.title || 'Table action');
    const results = await runSql(connection, sql);
    if (collectMessages(results).length) {
      return renderWriteResult(req, res, connection, table, `${options.title || 'Table action'} result`, results, options.backHref);
    }
    if (options.destination === 'connection') {
      if (isHtmx(req)) {
        return respondConnectionHome(req, res, connection, {
          pushUrl: `/connections/${connection.id}`,
          toasts: [{ type: 'success', message: options.successMessage || `${options.title} done` }]
        });
      }
      return redirect(res, `/connections/${connection.id}`);
    }
    return browseSuccess(req, res, connection, table, options.successMessage || `${options.title} done`);
  } catch (error) {
    return renderTableActionError(req, res, connection, table, `${options.title || 'Table action'} failed`, error.message);
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
        return renderColumnSqlPreview(req, res, connection, table, 'Add column', sql, action, form, false);
      }
      const results = await runSql(connection, sql);
      if (collectMessages(results).length) {
        return renderWriteResult(req, res, connection, table, 'Add column result', results);
      }
      return browseSuccess(req, res, connection, table, 'Column added');
    }
    return renderColumnSqlPreview(req, res, connection, table, 'Add column', sql, action, form, false);
  } catch (error) {
    return renderTableActionError(req, res, connection, table, 'Add column failed', error.message);
  }
}

async function renderDropColumnPreview(req, res, connection, table, column) {
  try {
    const { fields } = await loadTableContext(connection, table, 'DROP COLUMN');
    const sql = buildAlterDropColumnSql(table, column, fields);
    return renderColumnSqlPreview(
      req,
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
    return renderTableActionError(req, res, connection, table, 'Drop column failed', error.message);
  }
}

async function handleDropColumn(req, res, connection, table, column) {
  const form = await readForm(req);
  try {
    const { fields } = await loadTableContext(connection, table, 'DROP COLUMN');
    const sql = buildAlterDropColumnSql(table, column, fields);
    if (!samePreviewSql(form.sql_preview, sql)) {
      return renderDropColumnPreview(req, res, connection, table, column);
    }
    const results = await runSql(connection, sql);
    if (collectMessages(results).length) {
      return renderWriteResult(req, res, connection, table, 'Drop column result', results);
    }
    return browseSuccess(req, res, connection, table, 'Column dropped');
  } catch (error) {
    return renderTableActionError(req, res, connection, table, 'Drop column failed', error.message);
  }
}

async function renderModifyColumnPreview(req, res, connection, table, column) {
  try {
    const { fields } = await loadTableContext(connection, table, 'MODIFY COLUMN');
    const sql = buildAlterModifyBigintSql(table, column, fields);
    return renderColumnSqlPreview(
      req,
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
    return renderTableActionError(req, res, connection, table, 'Modify column failed', error.message);
  }
}

async function handleModifyColumn(req, res, connection, table, column) {
  const form = await readForm(req);
  try {
    const { fields } = await loadTableContext(connection, table, 'MODIFY COLUMN');
    const sql = buildAlterModifyBigintSql(table, column, fields);
    if (!samePreviewSql(form.sql_preview, sql)) {
      return renderModifyColumnPreview(req, res, connection, table, column);
    }
    const results = await runSql(connection, sql);
    if (collectMessages(results).length) {
      return renderWriteResult(req, res, connection, table, 'Modify column result', results);
    }
    return browseSuccess(req, res, connection, table, 'Column widened to bigint');
  } catch (error) {
    return renderTableActionError(req, res, connection, table, 'Modify column failed', error.message);
  }
}

function renderColumnSqlPreview(req, res, connection, table, title, sql, action, hidden, destructive, message = '') {
  return respond(req, res, 200, {
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
  });
}

function renderTableActionError(req, res, connection, table, title, message) {
  return respond(req, res, 400, {
    title,
    body: renderOperationPage({
      title,
      message,
      backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
    })
  });
}

async function renderInsertForm(req, res, connection, table, values = {}, error = '') {
  try {
    const { fields } = await loadTableContext(connection, table, 'Insert row');
    return respond(req, res, error ? 400 : 200, renderRowEditPage({
      connection,
      table,
      fields,
      values,
      mode: 'insert',
      error
    }));
  } catch (loadError) {
    return renderTableActionError(req, res, connection, table, 'Insert row unavailable', loadError.message);
  }
}

async function renderEditForm(req, res, connection, table, rowId, error = '') {
  try {
    const { fields, schemaData } = await loadTableContext(connection, table, 'Edit row');
    const rowResults = await selectRowById(connection, table, rowId);
    const row = rowResults[0]?.data?.[0] || { id: rowId };
    const messages = [...collectMessages(schemaData.results), ...collectMessages(rowResults)];
    const messageError = messages.map((message) => message.message).join('\n');
    return respond(req, res, hasResultErrors(schemaData.results) || hasResultErrors(rowResults) ? 400 : 200, renderRowEditPage({
      connection,
      table,
      fields,
      values: row,
      mode: 'edit',
      error: error || messageError || (!rowResults[0]?.data?.[0] ? 'Row not found' : '')
    }));
  } catch (loadError) {
    return renderTableActionError(req, res, connection, table, 'Edit row unavailable', loadError.message);
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
      return renderJsonWriteResult(req, res, connection, table, 'Insert result', messages);
    }
    return browseSuccess(req, res, connection, table, 'Row inserted');
  } catch (error) {
    return renderInsertForm(req, res, connection, table, form, error.message);
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
      return renderJsonWriteResult(req, res, connection, table, 'Edit result', messages);
    }
    return browseSuccess(req, res, connection, table, 'Row saved');
  } catch (error) {
    return renderEditForm(req, res, connection, table, rowId, error.message);
  }
}

async function renderDeleteRowPreview(req, res, connection, table, rowId) {
  try {
    await loadTableContext(connection, table, 'Delete row');
    const sql = buildDeleteSql(table, rowId);
    return respond(req, res, 200, {
      title: 'Delete row',
      body: renderSqlPreviewForm({
        title: 'Delete row',
        sql,
        action: `/connections/${connection.id}/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(rowId)}/delete`,
        submitLabel: 'Delete row',
        destructive: true,
        backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
      })
    });
  } catch (error) {
    return renderTableActionError(req, res, connection, table, 'Delete row unavailable', error.message);
  }
}

async function handleDeleteRow(req, res, connection, table, rowId) {
  const form = await readForm(req);
  try {
    await loadTableContext(connection, table, 'Delete row');
    const sql = buildDeleteSql(table, rowId);
    if (!samePreviewSql(form.sql_preview, sql)) {
      return renderDeleteRowPreview(req, res, connection, table, rowId);
    }
    const results = await runSql(connection, sql);
    if (collectMessages(results).length) {
      return renderWriteResult(req, res, connection, table, 'Delete result', results);
    }
    return browseSuccess(req, res, connection, table, 'Row deleted');
  } catch (error) {
    return respond(req, res, 400, {
      title: 'Delete failed',
      body: renderOperationPage({
        title: 'Delete failed',
        message: error.message,
        backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
      })
    });
  }
}

function renderWriteResult(req, res, connection, table, title, results, backHref = '') {
  const messages = collectMessages(results);
  return respond(req, res, hasResultErrors(results) ? 400 : 200, {
    title,
    body: renderOperationPage({
      title,
      messages,
      backHref: backHref || `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
    })
  });
}

function renderJsonWriteResult(req, res, connection, table, title, messages) {
  return respond(req, res, messages.some((message) => message.type === 'error') ? 400 : 200, {
    title,
    body: renderOperationPage({
      title,
      messages,
      backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
    })
  });
}

function samePreviewSql(submitted, expected) {
  return normalizePreviewSql(submitted) === normalizePreviewSql(expected);
}

function normalizePreviewSql(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

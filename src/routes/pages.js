import {
  attributeFields,
  buildAlterAddColumnSql,
  buildAlterDropColumnSql,
  buildAlterModifyBigintSql,
  buildDeleteSql,
  connectionBaseUrl,
  buildCreateTableSql,
  buildDropTableSql,
  buildMatchExpression,
  buildSearchCountSql,
  buildSearchSql,
  buildTruncateTableSql,
  callAutocomplete,
  callKeywordStats,
  callQsuggest,
  collectJsonMessages,
  collectMessages,
  countRows,
  defaultRanker,
  demoteMultiMeta,
  describeTable,
  explainQuery,
  filterableFields,
  findTable,
  hasResultErrors,
  insertDocument,
  isRealtimeTable,
  listTables,
  looksLikeMetaSet,
  maxBrowseWindow,
  parseMinInfixLen,
  parseShowMeta,
  ping,
  requireRealtimeTable,
  runSql,
  runSqlStatements,
  saveRow,
  searchCapabilities,
  searchRankers,
  selectRowById,
  selectRows,
  showCreateTable,
  showTableSettings,
  showTableStatus,
  splitSqlStatements,
  textFields
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
import { columnNames, escapeHtml, valueToText } from '../html.js';
import { fragment, layout } from '../views/layout.js';
import {
  renderBrowseDataPanel,
  renderBrowsePage,
  renderConnectionPage,
  renderCreateTablePage,
  renderRowEditPage
} from '../views/browse.js';
import { renderConsolePage, renderConsoleResults } from '../views/console.js';
import {
  renderAutocompleteDatalist,
  renderExplainBody,
  renderFilterBlock,
  renderSearchReproducePanel,
  renderRowDetail,
  renderSearchPage,
  renderSearchResults,
  searchBasePath,
  searchDefaultPerPage
} from '../views/search.js';
import { renderDashboardPage, renderEditConnectionPage } from '../views/dashboard.js';
import { renderLoginPage } from '../views/login.js';
import { renderAlert, renderOperationPage, renderSqlPreviewForm, renderToastsOob } from '../views/components.js';

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
      const prefill = url.searchParams.has('sql')
        ? String(url.searchParams.get('sql') || '').slice(0, 50000)
        : undefined;
      return respond(req, res, 200, renderConsolePage({
        connection,
        ...(prefill !== undefined ? { sql: prefill } : {})
      }));
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

  if (parts.length === 2 && parts[1] === 'search' && req.method === 'GET') {
    return handleSearch(req, res, connection, table, url);
  }

  if (parts.length === 3 && parts[1] === 'search' && parts[2] === 'autocomplete' && req.method === 'GET') {
    return handleSearchAutocomplete(req, res, connection, table, url);
  }

  if (parts.length === 3 && parts[1] === 'search' && parts[2] === 'explain' && req.method === 'GET') {
    return handleSearchExplain(req, res, connection, table, url);
  }

  if (parts.length === 4 && parts[1] === 'rows' && parts[3] === 'view' && req.method === 'GET') {
    return handleRowView(req, res, connection, table, parts[2]);
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

// ---------------------------------------------------------------------------
// Search (§4.7). GET-only: the whole search state lives in the URL, so every
// query, facet click and page turn is shareable and history-friendly. The
// form swaps #search-results; the response also re-sends the #filter-block
// chips inside the form as an out-of-band swap so they track the URL.
// ---------------------------------------------------------------------------

function buildSearchProfile({ fields, tableMeta, caps, settingsResults }) {
  const text = textFields(fields);
  const minInfixLen = parseMinInfixLen(settingsResults?.[0]);
  return {
    fields,
    hasText: text.length > 0,
    canWrite: isRealtimeTable(tableMeta),
    buddy: caps.buddy,
    // CALL AUTOCOMPLETE / SUGGEST need Buddy AND min_infix_len on the table;
    // when either is missing the controls are simply not rendered (§4.7).
    autocomplete: caps.buddy && minInfixLen > 0 && text.length > 0,
    suggest: caps.buddy && minInfixLen > 0 && text.length > 0,
    minInfixLen
  };
}

function parseFilterToken(raw) {
  const text = String(raw ?? '');
  const first = text.indexOf('|');
  const second = text.indexOf('|', first + 1);
  if (first < 1 || second < 0) return null;
  return {
    attr: text.slice(0, first).trim(),
    op: text.slice(first + 1, second).trim(),
    value: text.slice(second + 1)
  };
}

// URL/query-string -> normalized search state. Unknown fields, rankers and
// facet attributes are silently dropped (a shared URL must survive schema
// drift); semantic conflicts (fuzzy+advanced, ...) are rejected later in
// executeSearch so the form still renders with the user's input.
function parseSearchState(searchParams, profile) {
  const textNames = textFields(profile.fields).map((item) => item.name);
  const filterableNames = new Set(filterableFields(profile.fields).map((item) => item.name));

  const q = profile.hasText ? String(searchParams.get('q') || '').trim().slice(0, 2000) : '';
  const mode = searchParams.get('mode') === 'advanced' ? 'advanced' : 'plain';

  let fields = [...new Set(searchParams.getAll('field'))].filter((name) => textNames.includes(name));
  if (fields.length >= textNames.length) fields = [];

  const rankerParam = String(searchParams.get('ranker') || '').trim();
  const ranker = searchRankers.includes(rankerParam) ? rankerParam : defaultRanker;

  const weights = {};
  for (const name of textNames) {
    const value = searchParams.get(`w_${name}`);
    if (value !== null && String(value).trim() !== '') weights[name] = String(value).trim().slice(0, 12);
  }

  const facetParam = String(searchParams.get('facet') || '').trim();
  const facet = filterableNames.has(facetParam) ? facetParam : '';

  const filters = [];
  const seen = new Set();
  const pushFilter = (filter) => {
    if (!filter || !filter.attr || filters.length >= 12) return;
    const key = `${filter.attr}|${filter.op}|${filter.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    filters.push(filter);
  };
  for (const token of searchParams.getAll('f')) pushFilter(parseFilterToken(token));
  const nfAttr = String(searchParams.get('nf_attr') || '').trim();
  if (nfAttr) {
    pushFilter({
      attr: nfAttr,
      op: String(searchParams.get('nf_op') || '=').trim() || '=',
      value: String(searchParams.get('nf_value') ?? '')
    });
  }

  return {
    q,
    mode,
    fields,
    ranker,
    weights,
    facet,
    filters,
    page: clampInteger(searchParams.get('page'), 1, 1, 1000000),
    perPage: clampInteger(searchParams.get('perPage'), searchDefaultPerPage, 1, 200),
    fuzzy: searchParams.get('fuzzy') === '1',
    distance: String(searchParams.get('distance') || '').trim().slice(0, 2),
    preserve: searchParams.get('preserve') === '1',
    layouts: String(searchParams.get('layouts') || '').trim().slice(0, 30)
  };
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildSqlCurl(connection, sql) {
  const url = `${connectionBaseUrl(connection)}/sql?mode=raw`;
  return [
    `curl -sS -X POST ${shellSingleQuote(url)} \\`,
    `  -H ${shellSingleQuote('Content-Type: text/plain; charset=utf-8')} \\`,
    `  --data-binary ${shellSingleQuote(sql)}`
  ].join('\n');
}

function buildSearchReproduce(connection, { sql, countSql = '', label = 'Search request' }) {
  if (!sql) return null;
  const authType = String(connection.auth_type || 'none');
  return {
    label,
    method: 'POST',
    path: '/sql?mode=raw',
    contentType: 'text/plain; charset=utf-8',
    url: `${connectionBaseUrl(connection)}/sql?mode=raw`,
    sql: String(sql),
    countSql: countSql && countSql !== sql ? String(countSql) : '',
    curl: buildSqlCurl(connection, sql),
    authNote: authType !== 'none'
      ? `This connection uses ${authType} auth. MantiFox forwarded the Authorization header, but the secret value is intentionally not rendered here.`
      : ''
  };
}

// Runs the search and shapes everything the results block needs. User-input
// problems (bad filter value, fuzzy misuse, MATCH syntax in advanced mode)
// come back as { error } so the form survives; transport failures throw.
async function executeSearch(connection, table, profile, state, caps) {
  const allTextFieldNames = textFields(profile.fields).map((item) => item.name);

  let matchExpression = '';
  let countSql = '';
  let searchSql = '';
  const appendMeta = caps.multiMeta;
  try {
    if (state.fuzzy && !profile.buddy) {
      throw Object.assign(new Error('Fuzzy search needs the Manticore Buddy component, which this server does not report.'), { statusCode: 400 });
    }
    if (state.fuzzy && state.mode === 'advanced') {
      throw Object.assign(new Error('Fuzzy search works in Plain mode only — it accepts bare words, not MATCH operators.'), { statusCode: 400 });
    }
    if (state.fuzzy && state.fields.length) {
      throw Object.assign(new Error('Fuzzy search cannot be limited to specific fields — field scoping uses the @ operator, which fuzzy does not accept.'), { statusCode: 400 });
    }

    matchExpression = profile.hasText
      ? buildMatchExpression({
        mode: state.mode,
        query: state.q,
        fieldNames: state.fields,
        allTextFieldNames,
        fuzzy: state.fuzzy
      })
      : '';

    const common = {
      table,
      fields: profile.fields,
      matchExpression,
      filters: state.filters,
      fuzzy: state.fuzzy && Boolean(matchExpression),
      distance: state.distance,
      preserve: state.preserve,
      layouts: state.layouts
    };
    countSql = buildSearchCountSql(common);

    const countSets = await runSql(connection, countSql);
    if (hasResultErrors(countSets)) {
      return {
        error: collectMessages(countSets).map((message) => message.message).join('\n'),
        reproduce: buildSearchReproduce(connection, {
          sql: countSql,
          label: 'Count request'
        })
      };
    }
    const countRow = countSets[0]?.data?.[0] || {};
    const total = Number(countRow.count ?? countRow['count(*)'] ?? Object.values(countRow)[0] ?? 0) || 0;

    // Same clamp as browse (§4.2): never request a page whose OPTION
    // max_matches could exhaust the node, and never point past the last row.
    const maxPage = Math.max(1, Math.min(
      Math.ceil(total / state.perPage) || 1,
      Math.floor(maxBrowseWindow / state.perPage)
    ));
    if (state.page > maxPage) state.page = maxPage;
    const offset = (state.page - 1) * state.perPage;

    const selectOptions = {
      ...common,
      ranker: state.ranker,
      weights: state.weights,
      facet: state.facet,
      limit: state.perPage,
      offset
    };
    let metaAppended = appendMeta && Boolean(matchExpression);
    searchSql = buildSearchSql({ ...selectOptions, appendMeta: metaAppended });

    const startedAt = Date.now();
    let sets;
    try {
      sets = await runSql(connection, searchSql);
    } catch (error) {
      // Multi-statement is not dependable across versions (§4.1): if the
      // `; SHOW META` variant is what failed, drop to the single statement and
      // remember that for this connection.
      if (error.manticoreStatus && metaAppended) {
        demoteMultiMeta(connection);
        metaAppended = false;
        searchSql = buildSearchSql({ ...selectOptions, appendMeta: false });
        sets = await runSql(connection, searchSql);
      } else {
        throw error;
      }
    }
    // Some builds "accept" the multi-statement but answer with a single or
    // meta-less set (seen with other statement pairs on the test node). If the
    // hits set is missing or META did not arrive, retreat the same way.
    if (metaAppended && (sets.length < 2 || looksLikeMetaSet(sets[0]) || !looksLikeMetaSet(sets[sets.length - 1]))) {
      demoteMultiMeta(connection);
      metaAppended = false;
      if (sets.length !== 1 || looksLikeMetaSet(sets[0])) {
        searchSql = buildSearchSql({ ...selectOptions, appendMeta: false });
        sets = await runSql(connection, searchSql);
      }
    }
    const elapsedMs = Date.now() - startedAt;

    const hits = sets[0] || { columns: [], data: [], total: 0, error: '', warning: '' };
    if (hits.error) return { error: hits.error };

    const messages = [];
    for (const message of collectMessages(countSets)) {
      if (message.type === 'warning') messages.push({ type: 'warning', message: message.message });
    }
    sets.forEach((set, index) => {
      if (set?.warning) messages.push({ type: 'warning', message: set.warning });
      if (index > 0 && set?.error) messages.push({ type: 'error', message: set.error });
    });

    const rows = hits.data || [];

    let insight = null;
    if (matchExpression) {
      const lastSet = sets[sets.length - 1];
      const metaSet = metaAppended && sets.length > 1 && looksLikeMetaSet(lastSet) ? lastSet : null;
      if (metaSet) {
        const meta = parseShowMeta(metaSet);
        insight = {
          totalFound: meta.totalFound || String(total),
          total: String(rows.length),
          time: meta.time,
          elapsedMs,
          keywords: meta.keywords,
          source: 'meta'
        };
      } else {
        let keywords = [];
        try {
          keywords = (await callKeywordStats(connection, table, matchExpression)).keywords;
        } catch {
          keywords = [];
        }
        insight = {
          totalFound: String(total),
          total: String(rows.length),
          time: '',
          elapsedMs,
          keywords,
          source: 'keywords'
        };
      }
    }

    let facet = null;
    if (state.facet) {
      const candidates = sets.slice(1).filter((set) => !looksLikeMetaSet(set) && !set?.error);
      const facetSet = candidates.find((set) => columnNames(set)[0] === state.facet) || candidates[0] || null;
      if (facetSet) {
        const cols = columnNames(facetSet);
        facet = {
          attr: state.facet,
          values: (facetSet.data || []).map((row) => ({
            value: valueToText(row[cols[0]]),
            count: valueToText(row[cols[1] ?? 'count(*)'])
          }))
        };
      }
    }

    let didYouMean = null;
    if (total === 0 && matchExpression && state.mode === 'plain' && !state.fuzzy && profile.suggest) {
      try {
        const { suggestions } = await callQsuggest(connection, table, state.q);
        const best = suggestions.find((entry) => entry.distance > 0);
        if (best) {
          const corrected = state.q.replace(/\S+\s*$/u, best.suggest);
          if (corrected && corrected !== state.q) {
            didYouMean = { query: corrected, suggest: best.suggest, docs: best.docs };
          }
        }
      } catch {
        // did-you-mean is best-effort; a failed suggestion never breaks results
      }
    }

    return {
      hits,
      total,
      messages,
      insight,
      facet,
      didYouMean,
      reproduce: buildSearchReproduce(connection, {
        sql: searchSql,
        countSql,
        label: 'Search request'
      })
    };
  } catch (error) {
    // Bad input and query-level Manticore failures (it answers even syntax
    // errors with HTTP 500) belong inline in the results panel, with the form
    // intact; only transport problems bubble up as unreachable-node errors.
    if (error.statusCode === 400 || error.manticoreStatus) {
      return {
        error: error.message,
        reproduce: buildSearchReproduce(connection, {
          sql: searchSql || countSql,
          countSql,
          label: searchSql ? 'Search request' : 'Count request'
        })
      };
    }
    throw error;
  }
}

async function handleSearch(req, res, connection, table, url) {
  try {
    const caps = await searchCapabilities(connection);
    const [tablesData, schemaData, settingsResults] = await Promise.all([
      listTables(connection),
      describeTable(connection, table),
      // settings only feed the autocomplete/suggest gate; a table type that
      // cannot answer SHOW TABLE ... SETTINGS must not break the screen
      showTableSettings(connection, table).catch(() => [])
    ]);
    const tableMeta = findTable(tablesData.tables, table);
    if (!tableMeta) return respondNotFound(req, res, `Table ${table} not found`);
    if (hasResultErrors(schemaData.results)) {
      throw new Error(collectMessages(schemaData.results).map((message) => message.message).join('\n') || 'Could not read the table schema');
    }

    const profile = buildSearchProfile({ fields: schemaData.fields, tableMeta, caps, settingsResults });
    const state = parseSearchState(url.searchParams, profile);
    const results = await executeSearch(connection, table, profile, state, caps);
    const status = results.error ? 400 : 200;

    if (isHtmx(req) && htmxTarget(req) === 'search-results') {
      const body = renderFilterBlock({ basePath: searchBasePath(connection, table), profile, state, oob: true })
        + renderSearchReproducePanel({ connection, results, oob: true })
        + renderSearchResults({ connection, table, profile, state, results });
      return sendHtml(res, status, body, pageHeaders);
    }
    return respond(req, res, status, renderSearchPage({ connection, table, profile, state, results }));
  } catch (error) {
    const status = error.statusCode || 502;
    if (isHtmx(req)) return respondToastError(res, status, error.message || 'Search failed');
    return respond(req, res, status, {
      title: 'Search unavailable',
      body: renderOperationPage({
        title: 'Search unavailable',
        message: error.message || 'Search failed',
        backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
      })
    });
  }
}

// As-you-type datalist options. Best-effort by design: any failure (no Buddy,
// no min_infix_len, table gone) renders an empty datalist — never an error
// toast on every keystroke.
async function handleSearchAutocomplete(req, res, connection, table, url) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
  try {
    const caps = await searchCapabilities(connection);
    if (!q || !caps.buddy) return sendHtml(res, 200, renderAutocompleteDatalist([]), pageHeaders);
    const { suggestions } = await callAutocomplete(connection, table, q);
    return sendHtml(res, 200, renderAutocompleteDatalist(suggestions), pageHeaders);
  } catch {
    return sendHtml(res, 200, renderAutocompleteDatalist([]), pageHeaders);
  }
}

// Lazy body of the "Explain query" details block in the insight panel.
async function handleSearchExplain(req, res, connection, table, url) {
  try {
    const schemaData = await describeTable(connection, table);
    if (hasResultErrors(schemaData.results)) {
      return sendHtml(res, 200, renderExplainBody({
        error: collectMessages(schemaData.results).map((message) => message.message).join('\n')
      }), pageHeaders);
    }
    const profile = { fields: schemaData.fields, hasText: textFields(schemaData.fields).length > 0 };
    const state = parseSearchState(url.searchParams, profile);
    // EXPLAIN always uses the non-fuzzy expression: fuzzy expansion happens in
    // Buddy, and the plain words are what the parser tree explains.
    const matchExpression = buildMatchExpression({
      mode: state.mode,
      query: state.q,
      fieldNames: state.fields,
      allTextFieldNames: textFields(profile.fields).map((item) => item.name),
      fuzzy: false
    });
    if (!matchExpression) return sendHtml(res, 200, renderExplainBody({}), pageHeaders);
    const sets = await explainQuery(connection, table, matchExpression);
    const errorText = collectMessages(sets).filter((message) => message.type === 'error')
      .map((message) => message.message).join('\n');
    if (errorText) return sendHtml(res, 200, renderExplainBody({ error: errorText }), pageHeaders);
    const row = sets[0]?.data?.[0] || {};
    const tree = String(row.Value ?? Object.values(row).at(-1) ?? '');
    return sendHtml(res, 200, renderExplainBody({ tree }), pageHeaders);
  } catch (error) {
    return sendHtml(res, error.statusCode && error.statusCode < 500 ? error.statusCode : 200, renderExplainBody({ error: error.message }), pageHeaders);
  }
}

// Full record for a search hit ("view row"). htmx requests get the inline
// detail card (the hit's own container is the target); direct loads get a
// standalone page, so the URL stays deep-linkable.
async function handleRowView(req, res, connection, table, rowId) {
  try {
    const [tablesData, schemaData, rowResults] = await Promise.all([
      listTables(connection),
      describeTable(connection, table),
      selectRowById(connection, table, rowId)
    ]);
    const tableMeta = findTable(tablesData.tables, table);
    if (!tableMeta) return respondNotFound(req, res, `Table ${table} not found`);

    const row = rowResults[0]?.data?.[0] || null;
    const canWrite = isRealtimeTable(tableMeta);
    const errorText = [...collectMessages(schemaData.results), ...collectMessages(rowResults)]
      .map((message) => message.message).join('\n');

    if (isHtmx(req)) {
      if (!row) return sendHtml(res, 404, renderAlert(errorText || `Row ${rowId} not found`), pageHeaders);
      return sendHtml(res, 200, renderRowDetail({
        connection, table, fields: schemaData.fields, row, canWrite, asFragment: true
      }), pageHeaders);
    }
    if (!row) return respondNotFound(req, res, errorText || `Row ${rowId} not found`);
    return respond(req, res, 200, renderRowDetail({
      connection, table, fields: schemaData.fields, row, canWrite, asFragment: false
    }));
  } catch (error) {
    const status = error.statusCode || 502;
    if (isHtmx(req)) return sendHtml(res, status, renderAlert(error.message || 'Could not load the row'), pageHeaders);
    return respond(req, res, status, {
      title: 'Row unavailable',
      body: renderOperationPage({
        title: 'Row unavailable',
        message: error.message || 'Could not load the row',
        backHref: `/connections/${connection.id}/tables/${encodeURIComponent(table)}`
      })
    });
  }
}

async function renderBrowse(req, res, connection, table, query, extras = {}) {
  let page = clampInteger(query.page, 1, 1, 1000000);
  const perPage = clampInteger(query.perPage, 25, 1, 200);
  let search = query.q || '';
  const dir = query.dir === 'desc' ? 'desc' : 'asc';
  let sort = query.sort || '';

  try {
    const tablesData = await listTables(connection);
    const schemaData = await describeTable(connection, table);
    const tableMeta = findTable(tablesData.tables, table);
    const validFields = new Set(schemaData.fields.map((field) => field.name));
    if (sort && !validFields.has(sort)) sort = '';

    // MATCH() is an error on tables without a text field (§4.7) — drop a
    // crafted/stale ?q instead of sending a doomed statement, and say so.
    const hasText = textFields(schemaData.fields).length > 0;
    const searchGateMessages = [];
    if (search && !hasText) {
      search = '';
      searchGateMessages.push({
        type: 'warning',
        message: 'This table has no full-text fields, so the text search was ignored. Use "Filter rows" to filter by attributes.'
      });
    }

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
      ...searchGateMessages,
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
        canWrite,
        hasText
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
    const { plan, payload } = await saveRow(connection, table, rowId, fields, values);
    const messages = payload ? collectJsonMessages(payload) : [];
    if (messages.length) {
      return renderJsonWriteResult(req, res, connection, table, 'Edit result', messages);
    }
    return browseSuccess(req, res, connection, table, plan.mode === 'none' ? 'No changes to save' : 'Row saved');
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

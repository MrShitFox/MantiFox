import { columnNames, escapeAttr, escapeHtml, urlWithParams, valueToText } from '../html.js';
import { renderAlert, renderMessages, renderRowForm, renderStatusTable } from './components.js';
import { layout } from './layout.js';

export function renderConnectionPage({ connection, tables = [], messages = [], error = '' }) {
  return layout({
    title: `${connection.name} tables`,
    body: `<section class="page-heading">
      <div>
        <h1>${escapeHtml(connection.name)}</h1>
        <p>Tables exposed by <code>${escapeHtml(connection.host)}:${escapeHtml(connection.port)}</code>.</p>
      </div>
      <a class="button secondary" href="/connections/${connection.id}/console">Open SQL console</a>
    </section>
    ${renderAlert(error)}
    ${renderMessages(messages)}
    <section class="panel">
      <h2>Tables</h2>
      ${renderTableList(connection, tables)}
    </section>`
  });
}

export function renderBrowsePage({
  connection,
  table,
  tables = [],
  schema = [],
  statusResult,
  rowsResult,
  total = 0,
  page = 1,
  perPage = 25,
  search = '',
  sort = '',
  dir = 'asc',
  messages = [],
  error = ''
}) {
  const offset = (page - 1) * perPage;
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  const rows = rowsResult?.data || [];
  const columns = columnNames(rowsResult);
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;

  return layout({
    title: `${table} - ${connection.name}`,
    body: `<section class="page-heading">
      <div>
        <p><a href="/connections/${connection.id}">${escapeHtml(connection.name)}</a></p>
        <h1>${escapeHtml(table)}</h1>
      </div>
      <div class="button-row">
        <a class="button" href="${basePath}/new">Insert row</a>
        <a class="button secondary" href="/connections/${connection.id}/console">SQL console</a>
      </div>
    </section>
    ${renderAlert(error)}
    ${renderMessages(messages)}
    <div class="browse-grid">
      <aside class="panel table-sidebar">
        <h2>Tables</h2>
        ${renderTableList(connection, tables, table)}
      </aside>
      <section class="panel data-panel">
        <form method="get" action="${escapeAttr(basePath)}" class="toolbar">
          <label>
            <span>Full-text search</span>
            <input name="q" value="${escapeAttr(search)}" placeholder="MATCH query">
          </label>
          <label>
            <span>Rows</span>
            <select name="perPage">
              ${[10, 25, 50, 100].map((value) => `<option value="${value}" ${value === perPage ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </label>
          ${sort ? `<input type="hidden" name="sort" value="${escapeAttr(sort)}">` : ''}
          ${dir ? `<input type="hidden" name="dir" value="${escapeAttr(dir)}">` : ''}
          <button type="submit">Apply</button>
          ${search ? `<a href="${basePath}" class="button secondary">Clear</a>` : ''}
        </form>
        <p class="muted">Showing ${escapeHtml(offset + (rows.length ? 1 : 0))}-${escapeHtml(offset + rows.length)} of ${escapeHtml(total)} rows.</p>
        ${renderDataGrid({ connection, table, columns, rows, page, perPage, search, sort, dir })}
        ${renderPagination({ basePath, page, maxPage, perPage, search, sort, dir })}
      </section>
    </div>
    <section class="panel">
      <h2>Schema</h2>
      ${renderSchema(schema)}
    </section>
    <section class="panel">
      <h2>Status</h2>
      ${renderStatusTable(statusResult?.[0]) || '<p class="empty">No status data.</p>'}
    </section>`
  });
}

export function renderRowEditPage({ connection, table, fields, values = {}, mode, error = '' }) {
  const title = mode === 'edit' ? 'Edit row' : 'Insert row';
  const rowId = values.id;
  const action = mode === 'edit'
    ? `/connections/${connection.id}/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(rowId)}/edit`
    : `/connections/${connection.id}/tables/${encodeURIComponent(table)}/new`;

  return layout({
    title: `${title} - ${table}`,
    body: `<section class="panel narrow">
      <p><a href="/connections/${connection.id}/tables/${encodeURIComponent(table)}">Back to ${escapeHtml(table)}</a></p>
      <h1>${escapeHtml(title)}</h1>
      ${renderRowForm({ action, mode, fields, values, error })}
    </section>`
  });
}

function renderTableList(connection, tables, selected = '') {
  if (!tables.length) return '<p class="empty">No tables.</p>';
  return `<ul class="table-list">${tables.map((table) => {
    const href = `/connections/${connection.id}/tables/${encodeURIComponent(table.name)}`;
    return `<li><a class="${table.name === selected ? 'active' : ''}" href="${href}">${escapeHtml(table.name)}${table.type ? ` <small>${escapeHtml(table.type)}</small>` : ''}</a></li>`;
  }).join('')}</ul>`;
}

function renderSchema(schema) {
  if (!schema.length) return '<p class="empty">No schema data.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Field</th><th>Type</th><th>Properties</th></tr></thead>
    <tbody>${schema.map((field) => `<tr>
      <td><code>${escapeHtml(field.name)}</code></td>
      <td>${escapeHtml(field.type)}</td>
      <td>${escapeHtml(field.properties)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function renderDataGrid({ connection, table, columns, rows, page, perPage, search, sort, dir }) {
  if (!columns.length) return '<p class="empty">No data columns.</p>';
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  return `<div class="table-wrap"><table class="data-grid">
    <thead><tr>${columns.map((column) => `<th>${sortLink({ basePath, column, page, perPage, search, sort, dir })}</th>`).join('')}<th>Actions</th></tr></thead>
    <tbody>
      ${rows.length ? rows.map((row) => `<tr>${columns.map((column) => `<td><code>${escapeHtml(valueToText(row[column]))}</code></td>`).join('')}<td>${renderRowActions(connection, table, row)}</td></tr>`).join('') : `<tr><td colspan="${columns.length + 1}" class="empty">No rows.</td></tr>`}
    </tbody>
  </table></div>`;
}

function sortLink({ basePath, column, page, perPage, search, sort, dir }) {
  const nextDir = sort === column && dir !== 'desc' ? 'desc' : 'asc';
  const href = urlWithParams(basePath, { page, perPage, q: search, sort: column, dir: nextDir });
  const marker = sort === column ? (dir === 'desc' ? ' desc' : ' asc') : '';
  return `<a href="${escapeAttr(href)}">${escapeHtml(column)}${escapeHtml(marker)}</a>`;
}

function renderRowActions(connection, table, row) {
  if (row.id === undefined || row.id === null || row.id === '') {
    return '<span class="muted">No id</span>';
  }
  const rowId = encodeURIComponent(String(row.id));
  const tablePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  return `<div class="button-row compact">
    <a class="button secondary" href="${tablePath}/rows/${rowId}/edit">Edit</a>
    <form method="post" action="${tablePath}/rows/${rowId}/delete" data-confirm="Delete row ${escapeAttr(row.id)}?">
      <button class="danger" type="submit">Delete</button>
    </form>
  </div>`;
}

function renderPagination({ basePath, page, maxPage, perPage, search, sort, dir }) {
  if (maxPage <= 1) return '';
  const previous = Math.max(1, page - 1);
  const next = Math.min(maxPage, page + 1);
  return `<nav class="pagination">
    <a class="button secondary ${page === 1 ? 'disabled' : ''}" href="${escapeAttr(urlWithParams(basePath, { page: previous, perPage, q: search, sort, dir }))}">Previous</a>
    <span>Page ${escapeHtml(page)} of ${escapeHtml(maxPage)}</span>
    <a class="button secondary ${page === maxPage ? 'disabled' : ''}" href="${escapeAttr(urlWithParams(basePath, { page: next, perPage, q: search, sort, dir }))}">Next</a>
  </nav>`;
}

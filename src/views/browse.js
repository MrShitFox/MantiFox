import { columnNames, escapeAttr, escapeHtml, urlWithParams, valueToText } from '../html.js';
import {
  renderAlert,
  renderMessages,
  renderRowForm,
  renderStatusTable
} from './components.js';
import { layout } from './layout.js';

const createColumnTypes = ['text', 'string', 'int', 'integer', 'bigint', 'float', 'bool', 'json', 'timestamp', 'multi', 'multi64', 'float_vector'];
const alterColumnTypes = ['text', 'string', 'int', 'integer', 'bigint', 'float', 'bool', 'json', 'timestamp', 'multi', 'multi64'];

export function renderConnectionPage({ connection, tables = [], messages = [], error = '' }) {
  return layout({
    title: `${connection.name} tables`,
    body: `<section class="page-heading">
      <div>
        <h1>${escapeHtml(connection.name)}</h1>
        <p>Tables exposed by <code>${escapeHtml(connection.host)}:${escapeHtml(connection.port)}</code>.</p>
      </div>
      <div class="button-row">
        <a class="button" href="/connections/${connection.id}/new-table">Create table</a>
        <a class="button secondary" href="/connections/${connection.id}/console">Open SQL console</a>
      </div>
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
  tableMeta = null,
  showCreateStatement = '',
  messages = [],
  error = ''
}) {
  const offset = (page - 1) * perPage;
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  const rows = rowsResult?.data || [];
  const columns = columnNames(rowsResult);
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  const tableType = tableMeta?.type || '';
  const canWrite = tableType === 'rt';

  return layout({
    title: `${table} - ${connection.name}`,
    body: `<section class="page-heading">
      <div>
        <p><a href="/connections/${connection.id}">${escapeHtml(connection.name)}</a></p>
        <h1>${escapeHtml(table)}</h1>
      </div>
      <div class="button-row">
        ${canWrite ? `<a class="button" href="${basePath}/new">Insert row</a>` : `<span class="button disabled" title="Row writes require an rt table">Insert row</span>`}
        ${canWrite ? `<a class="button secondary" href="${basePath}/truncate">Truncate</a>` : ''}
        ${canWrite ? `<a class="button secondary danger-link" href="${basePath}/drop">Drop table</a>` : ''}
        <a class="button secondary" href="/connections/${connection.id}/console">SQL console</a>
      </div>
    </section>
    ${renderAlert(error)}
    ${renderMessages(messages)}
    ${tableType && !canWrite ? renderAlert(`This table is ${tableType}. GUI row writes and ALTER actions are disabled because only rt tables support them.`, 'warning') : ''}
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
        ${renderDataGrid({ connection, table, columns, rows, page, perPage, search, sort, dir, canWrite })}
        ${renderPagination({ basePath, page, maxPage, perPage, search, sort, dir })}
      </section>
    </div>
    <section class="panel">
      <h2>Schema</h2>
      ${renderShowCreate(showCreateStatement)}
      ${renderSchema({ connection, table, schema, canAlter: canWrite })}
    </section>
    <section class="panel">
      <h2>Status</h2>
      ${renderStatusTable(statusResult?.[0]) || '<p class="empty">No status data.</p>'}
    </section>`
  });
}

export function renderCreateTablePage({ connection, values = {}, previewSql = '', showExecute = false, error = '' }) {
  const columns = createColumnsFromValues(values);
  const count = columns.length;

  return layout({
    title: `Create table - ${connection.name}`,
    body: `<section class="panel schema-builder">
      <p><a href="/connections/${connection.id}">Back to ${escapeHtml(connection.name)}</a></p>
      <h1>Create table</h1>
      ${renderAlert(error)}
      <form method="post" action="/connections/${connection.id}/new-table" class="stacked-form" data-create-table-form>
        <div class="two-cols">
          <label>
            <span>Table name</span>
            <input name="table_name" value="${escapeAttr(values.table_name || values.name || '')}" required pattern="[A-Za-z_][A-Za-z0-9_]*">
          </label>
          <label class="checkbox-card">
            <input type="checkbox" name="if_not_exists" value="1" ${values.if_not_exists ? 'checked' : ''}>
            <span>IF NOT EXISTS</span>
          </label>
        </div>
        <input type="hidden" name="column_count" value="${escapeAttr(count)}" data-column-count>
        <section class="subsection">
          <header class="section-bar">
            <h2>Columns</h2>
            <button type="button" class="secondary" data-add-column>Create column</button>
          </header>
          <div class="column-list" data-column-list>
            ${columns.map((column, index) => renderColumnBuilderRow({ column, index, mode: 'create' })).join('')}
          </div>
        </section>
        <details class="advanced-block" ${hasAdvancedValues(values) ? 'open' : ''}>
          <summary>Advanced table options</summary>
          <div class="form-grid">
            <label><span>min_infix_len</span><input name="min_infix_len" value="${escapeAttr(values.min_infix_len || '')}" inputmode="numeric"></label>
            <label><span>morphology</span><input name="morphology" value="${escapeAttr(values.morphology || '')}" placeholder="stem_en"></label>
            <label><span>engine</span><select name="engine">
              <option value="">Default</option>
              ${['rowwise', 'columnar'].map((engine) => `<option value="${engine}" ${values.engine === engine ? 'selected' : ''}>${engine}</option>`).join('')}
            </select></label>
            <label><span>rt_mem_limit</span><input name="rt_mem_limit" value="${escapeAttr(values.rt_mem_limit || '')}" placeholder="128M"></label>
            <label class="checkbox-card"><input type="checkbox" name="html_strip" value="1" ${values.html_strip ? 'checked' : ''}><span>html_strip='1'</span></label>
          </div>
          <label>
            <span>Extra options</span>
            <textarea name="extra_options" rows="3" placeholder="index_exact_words='1'">${escapeHtml(values.extra_options || '')}</textarea>
          </label>
        </details>
        ${previewSql ? `<label class="sql-preview">
          <span>SQL preview</span>
          <textarea readonly rows="8">${escapeHtml(previewSql)}</textarea>
        </label>
        <input type="hidden" name="sql_preview" value="${escapeAttr(previewSql)}">` : ''}
        <div class="form-actions">
          <button type="submit" name="intent" value="preview">Preview SQL</button>
          ${showExecute ? `<button type="submit" name="intent" value="execute">Create table</button>` : ''}
        </div>
      </form>
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

function renderShowCreate(statement) {
  if (!statement) return '<p class="empty">No SHOW CREATE TABLE output.</p>';
  return `<label class="sql-preview">
    <span>SHOW CREATE TABLE</span>
    <textarea readonly rows="6">${escapeHtml(statement)}</textarea>
  </label>`;
}

function renderSchema({ connection, table, schema, canAlter }) {
  if (!schema.length) return '<p class="empty">No schema data.</p>';
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  return `<div class="table-wrap schema-table"><table>
    <thead><tr><th>Field</th><th>Type</th><th>Properties</th>${canAlter ? '<th>Actions</th>' : ''}</tr></thead>
    <tbody>${schema.map((field) => `<tr>
      <td><code>${escapeHtml(field.name)}</code></td>
      <td>${escapeHtml(field.type)}</td>
      <td>${escapeHtml(field.properties)}</td>
      ${canAlter ? `<td>${renderColumnActions(basePath, field, schema)}</td>` : ''}
    </tr>`).join('')}</tbody>
  </table></div>
  ${canAlter ? renderAddColumnForm(basePath) : '<p class="muted">Schema editing is available only for rt tables.</p>'}`;
}

function renderDataGrid({ connection, table, columns, rows, page, perPage, search, sort, dir, canWrite }) {
  if (!columns.length) return '<p class="empty">No data columns.</p>';
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  return `<div class="table-wrap"><table class="data-grid">
    <thead><tr>${columns.map((column) => `<th>${sortLink({ basePath, column, page, perPage, search, sort, dir })}</th>`).join('')}${canWrite ? '<th>Actions</th>' : ''}</tr></thead>
    <tbody>
      ${rows.length ? rows.map((row) => `<tr>${columns.map((column) => `<td><code>${escapeHtml(valueToText(row[column]))}</code></td>`).join('')}${canWrite ? `<td>${renderRowActions(connection, table, row)}</td>` : ''}</tr>`).join('') : `<tr><td colspan="${columns.length + (canWrite ? 1 : 0)}" class="empty">No rows.</td></tr>`}
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
    <a class="button secondary danger-link" href="${tablePath}/rows/${rowId}/delete">Delete</a>
  </div>`;
}

function renderColumnActions(basePath, field, schema) {
  if (field.name === 'id') return '<span class="muted">Implicit</span>';
  const encoded = encodeURIComponent(field.name);
  const attributeCount = schema.filter(isAttributeLike).length;
  const canDrop = !(isAttributeLike(field) && attributeCount <= 1);
  return `<div class="button-row compact">
    ${canWidenToBigint(field) ? `<a class="button secondary" href="${basePath}/columns/${encoded}/modify-bigint">Widen to bigint</a>` : ''}
    ${canDrop ? `<a class="button secondary danger-link" href="${basePath}/columns/${encoded}/drop">Drop</a>` : '<span class="muted">Last attribute</span>'}
  </div>`;
}

function renderAddColumnForm(basePath) {
  return `<form method="post" action="${basePath}/columns/add" class="stacked-form add-column-form" data-column-kind>
    <h3>Add column</h3>
    <div class="form-grid">
      <label>
        <span>Name</span>
        <input name="column_name" required pattern="[A-Za-z_][A-Za-z0-9_]*">
      </label>
      <label>
        <span>Type</span>
        <select name="column_type" data-column-type>
          ${alterColumnTypes.map((type) => `<option value="${type}" ${type === 'string' ? 'selected' : ''}>${type}</option>`).join('')}
        </select>
      </label>
      <label class="checkbox-card column-modifier">
        <input type="checkbox" name="column_indexed" value="1">
        <span>indexed</span>
      </label>
      <label class="checkbox-card column-modifier">
        <input type="checkbox" name="column_attribute" value="1">
        <span>attribute</span>
      </label>
      <label class="checkbox-card json-option">
        <input type="checkbox" name="column_secondary_index" value="1">
        <span>secondary_index='1'</span>
      </label>
    </div>
    <div class="form-actions">
      <button type="submit" name="intent" value="preview">Preview ADD COLUMN SQL</button>
    </div>
  </form>`;
}

function renderColumnBuilderRow({ column = {}, index, mode }) {
  const type = column.type || (mode === 'create' ? 'text' : 'string');
  const types = mode === 'create' ? createColumnTypes : alterColumnTypes;
  const prefix = `col_${index}_`;
  return `<div class="column-row" data-column-row>
    <div class="column-row-main">
      <label>
        <span>Name</span>
        <input name="${prefix}name" value="${escapeAttr(column.name || '')}" required pattern="[A-Za-z_][A-Za-z0-9_]*">
      </label>
      <label>
        <span>Type</span>
        <select name="${prefix}type" data-column-type>
          ${types.map((candidate) => `<option value="${candidate}" ${candidate === type ? 'selected' : ''}>${candidate}</option>`).join('')}
        </select>
      </label>
      <button type="button" class="secondary compact-remove" data-remove-column>Remove</button>
    </div>
    <div class="column-flags" data-column-kind>
      <label class="checkbox-card column-modifier">
        <input type="checkbox" name="${prefix}indexed" value="1" ${column.indexed || (!column.type && mode === 'create') ? 'checked' : ''}>
        <span>indexed</span>
      </label>
      <label class="checkbox-card column-modifier ${mode === 'alter' ? 'hidden' : ''}">
        <input type="checkbox" name="${prefix}stored" value="1" ${column.stored || (!column.type && mode === 'create') ? 'checked' : ''}>
        <span>stored</span>
      </label>
      <label class="checkbox-card column-modifier">
        <input type="checkbox" name="${prefix}attribute" value="1" ${column.attribute ? 'checked' : ''}>
        <span>attribute</span>
      </label>
      <label class="checkbox-card json-option">
        <input type="checkbox" name="${prefix}secondary_index" value="1" ${column.secondary_index ? 'checked' : ''}>
        <span>secondary_index='1'</span>
      </label>
      <div class="vector-options">
        <label><span>knn_type</span><input name="${prefix}knn_type" value="${escapeAttr(column.knn_type || 'hnsw')}"></label>
        <label><span>knn_dims</span><input name="${prefix}knn_dims" value="${escapeAttr(column.knn_dims || '')}" inputmode="numeric"></label>
        <label><span>similarity</span><select name="${prefix}hnsw_similarity">
          ${['l2', 'ip', 'cosine'].map((similarity) => `<option value="${similarity}" ${similarity === (column.hnsw_similarity || 'l2') ? 'selected' : ''}>${similarity}</option>`).join('')}
        </select></label>
      </div>
    </div>
  </div>`;
}

function createColumnsFromValues(values) {
  const posted = Object.prototype.hasOwnProperty.call(values, 'column_count');
  const count = Math.max(Number.parseInt(String(values.column_count || '0'), 10) || 0, 1);
  const columns = [];
  for (let index = 0; index < count; index++) {
    const prefix = `col_${index}_`;
    const hasPostedType = Object.prototype.hasOwnProperty.call(values, `${prefix}type`);
    // Rows removed in the browser leave a gap in the col_N_* numbering while
    // column_count keeps the old total. Re-rendering that gap produced a ghost
    // empty-but-required column row that blocked the form. Skip gaps; the
    // remaining columns are re-indexed by their array position.
    if (posted && !hasPostedType && !values[`${prefix}name`]) continue;
    const defaultType = index === 0 ? 'text' : 'string';
    const type = values[`${prefix}type`] || defaultType;
    columns.push({
      name: values[`${prefix}name`] || '',
      type,
      indexed: hasPostedType ? Boolean(values[`${prefix}indexed`]) : type === 'text',
      stored: hasPostedType ? Boolean(values[`${prefix}stored`]) : type === 'text',
      attribute: Boolean(values[`${prefix}attribute`]),
      secondary_index: Boolean(values[`${prefix}secondary_index`]),
      knn_type: values[`${prefix}knn_type`] || 'hnsw',
      knn_dims: values[`${prefix}knn_dims`] || '',
      hnsw_similarity: values[`${prefix}hnsw_similarity`] || 'l2'
    });
  }
  if (!columns.length) columns.push({ type: 'text', indexed: true, stored: true });
  return columns;
}

function hasAdvancedValues(values) {
  return ['min_infix_len', 'morphology', 'engine', 'rt_mem_limit', 'html_strip', 'extra_options']
    .some((key) => Boolean(values[key]));
}

function isAttributeLike(field) {
  const type = String(field.type || '').toLowerCase();
  if (field.name === 'id') return false;
  if (type.includes('text')) return String(field.properties || '').toLowerCase().includes('attribute');
  return true;
}

function canWidenToBigint(field) {
  return ['int', 'integer', 'uint'].includes(String(field.type || '').toLowerCase());
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

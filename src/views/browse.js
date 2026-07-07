import { columnNames, escapeAttr, escapeHtml, urlWithParams } from '../html.js';
import {
  button,
  checkboxCard,
  codeCell,
  dataTable,
  emptyState,
  field,
  renderAlert,
  renderMessages,
  renderPagination,
  renderRowForm,
  renderStatusTable,
  selectInput,
  sqlPreviewBlock,
  textInput,
  textareaInput
} from './components.js';

const createColumnTypes = ['text', 'string', 'int', 'integer', 'bigint', 'float', 'bool', 'json', 'timestamp', 'multi', 'multi64', 'float_vector'];
const alterColumnTypes = ['text', 'string', 'int', 'integer', 'bigint', 'float', 'bool', 'json', 'timestamp', 'multi', 'multi64'];

export function renderConnectionPage({ connection, tables = [], messages = [], error = '' }) {
  return {
    title: `${connection.name} tables`,
    body: `<section class="page-heading">
      <div>
        <h1>${escapeHtml(connection.name)}</h1>
        <p>Tables exposed by <code>${escapeHtml(connection.host)}:${escapeHtml(connection.port)}</code>.</p>
      </div>
      <div class="button-row">
        ${button({ label: 'Create table', href: `/connections/${connection.id}/new-table` })}
        ${button({ label: 'Open SQL console', href: `/connections/${connection.id}/console`, variant: 'secondary' })}
      </div>
    </section>
    ${renderAlert(error)}
    ${renderMessages(messages)}
    <section class="panel">
      <h2>Tables</h2>
      ${renderTableList(connection, tables)}
    </section>`
  };
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
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  const tableType = tableMeta?.type || '';
  const canWrite = tableType === 'rt';

  return {
    title: `${table} - ${connection.name}`,
    body: `<section class="page-heading">
      <div>
        <p><a href="/connections/${connection.id}">${escapeHtml(connection.name)}</a></p>
        <h1>${escapeHtml(table)}</h1>
      </div>
      <div class="button-row">
        ${canWrite
          ? button({ label: 'Insert row', href: `${basePath}/new` })
          : button({ label: 'Insert row', href: `${basePath}/new`, disabled: true, title: 'Row writes require an rt table' })}
        ${canWrite ? button({ label: 'Truncate', href: `${basePath}/truncate`, variant: 'secondary' }) : ''}
        ${canWrite ? button({ label: 'Drop table', href: `${basePath}/drop`, variant: 'secondary danger-link' }) : ''}
        ${button({ label: 'SQL console', href: `/connections/${connection.id}/console`, variant: 'secondary' })}
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
      ${renderBrowseDataPanel({ connection, table, rowsResult, total, page, perPage, search, sort, dir, canWrite })}
    </div>
    <section class="panel">
      <h2>Schema</h2>
      ${renderShowCreate(showCreateStatement)}
      ${renderSchema({ connection, table, schema, canAlter: canWrite })}
    </section>
    <section class="panel">
      <h2>Status</h2>
      ${renderStatusTable(statusResult?.[0]) || emptyState('No status data.')}
    </section>`
  };
}

// The self-contained grid panel (search toolbar + rows + pagination). Search,
// sort, per-page and pagination requests swap ONLY this section (hx-target
// "#data-panel", outerHTML) so the sidebar/schema/status keep their state and
// scroll; hx-push-url keeps the URL shareable.
export function renderBrowseDataPanel({
  connection,
  table,
  rowsResult,
  total = 0,
  page = 1,
  perPage = 25,
  search = '',
  sort = '',
  dir = 'asc',
  canWrite = false
}) {
  const offset = (page - 1) * perPage;
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  const rows = rowsResult?.data || [];
  const columns = columnNames(rowsResult);
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;

  return `<section class="panel data-panel" id="data-panel">
    <form method="get" action="${escapeAttr(basePath)}" class="toolbar" hx-get="${escapeAttr(basePath)}" hx-target="#data-panel" hx-swap="outerHTML" hx-push-url="true" hx-sync="this:drop">
      ${field({ label: 'Full-text search', control: textInput({ name: 'q', value: search, attrs: { placeholder: 'MATCH query' } }) })}
      ${field({ label: 'Rows', control: selectInput({ name: 'perPage', value: perPage, options: [10, 25, 50, 100] }) })}
      ${sort ? `<input type="hidden" name="sort" value="${escapeAttr(sort)}">` : ''}
      ${dir ? `<input type="hidden" name="dir" value="${escapeAttr(dir)}">` : ''}
      ${button({ label: 'Apply', submit: true })}
      ${search ? button({ label: 'Clear', href: basePath, variant: 'secondary', attrs: dataPanelLinkAttrs(basePath) }) : ''}
    </form>
    <p class="muted">Showing ${escapeHtml(offset + (rows.length ? 1 : 0))}-${escapeHtml(offset + rows.length)} of ${escapeHtml(total)} rows.</p>
    ${renderDataGrid({ connection, table, columns, rows, page, perPage, search, sort, dir, canWrite })}
    ${renderPagination({ basePath, page, maxPage, perPage, search, sort, dir })}
  </section>`;
}

export function renderCreateTablePage({ connection, values = {}, previewSql = '', showExecute = false, error = '' }) {
  const columns = createColumnsFromValues(values);
  const count = columns.length;

  return {
    title: `Create table - ${connection.name}`,
    body: `<section class="panel schema-builder">
      <p><a href="/connections/${connection.id}">Back to ${escapeHtml(connection.name)}</a></p>
      <h1>Create table</h1>
      ${renderAlert(error)}
      <form method="post" action="/connections/${connection.id}/new-table" class="stacked-form" data-create-table-form data-preview-guard hx-sync="this:drop">
        <div class="two-cols">
          ${field({
            label: 'Table name',
            control: textInput({ name: 'table_name', value: values.table_name || values.name || '', attrs: { required: true, pattern: '[A-Za-z_][A-Za-z0-9_]*' } })
          })}
          ${checkboxCard({ name: 'if_not_exists', label: 'IF NOT EXISTS', checked: Boolean(values.if_not_exists) })}
        </div>
        <input type="hidden" name="column_count" value="${escapeAttr(count)}" data-column-count>
        <section class="subsection">
          <header class="section-bar">
            <h2>Columns</h2>
            ${button({ label: 'Create column', variant: 'secondary', attrs: { 'data-add-column': true } })}
          </header>
          <div class="column-list" data-column-list>
            ${columns.map((column, index) => renderColumnBuilderRow({ column, index, mode: 'create' })).join('')}
          </div>
        </section>
        <details class="advanced-block" ${hasAdvancedValues(values) ? 'open' : ''}>
          <summary>Advanced table options</summary>
          <div class="form-grid">
            ${field({ label: 'min_infix_len', control: textInput({ name: 'min_infix_len', value: values.min_infix_len || '', attrs: { inputmode: 'numeric' } }) })}
            ${field({ label: 'morphology', control: textInput({ name: 'morphology', value: values.morphology || '', attrs: { placeholder: 'stem_en' } }) })}
            ${field({
              label: 'engine',
              control: selectInput({
                name: 'engine',
                value: values.engine || '',
                options: [{ value: '', label: 'Default' }, 'rowwise', 'columnar']
              })
            })}
            ${field({ label: 'rt_mem_limit', control: textInput({ name: 'rt_mem_limit', value: values.rt_mem_limit || '', attrs: { placeholder: '128M' } }) })}
            ${checkboxCard({ name: 'html_strip', label: "html_strip='1'", checked: Boolean(values.html_strip) })}
          </div>
          ${field({
            label: 'Extra options',
            control: textareaInput({ name: 'extra_options', value: values.extra_options || '', rows: 3, attrs: { placeholder: "index_exact_words='1'" } })
          })}
        </details>
        ${previewSql ? `${sqlPreviewBlock({ sql: previewSql, rows: 8 })}
        <input type="hidden" name="sql_preview" value="${escapeAttr(previewSql)}">` : ''}
        <div class="form-actions">
          ${button({ label: 'Preview SQL', submit: true, attrs: { name: 'intent', value: 'preview' } })}
          ${showExecute ? button({ label: 'Create table', submit: true, attrs: { name: 'intent', value: 'execute' } }) : ''}
        </div>
      </form>
    </section>`
  };
}

export function renderRowEditPage({ connection, table, fields, values = {}, mode, error = '' }) {
  const title = mode === 'edit' ? 'Edit row' : 'Insert row';
  const rowId = values.id;
  const action = mode === 'edit'
    ? `/connections/${connection.id}/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(rowId)}/edit`
    : `/connections/${connection.id}/tables/${encodeURIComponent(table)}/new`;

  return {
    title: `${title} - ${table}`,
    body: `<section class="panel narrow">
      <p><a href="/connections/${connection.id}/tables/${encodeURIComponent(table)}">Back to ${escapeHtml(table)}</a></p>
      <h1>${escapeHtml(title)}</h1>
      ${renderRowForm({ action, mode, fields, values, error })}
    </section>`
  };
}

function dataPanelLinkAttrs(href) {
  return { 'hx-get': href, 'hx-target': '#data-panel', 'hx-swap': 'outerHTML', 'hx-push-url': 'true' };
}

function renderTableList(connection, tables, selected = '') {
  if (!tables.length) return emptyState('No tables.');
  return `<ul class="table-list">${tables.map((table) => {
    const href = `/connections/${connection.id}/tables/${encodeURIComponent(table.name)}`;
    return `<li><a class="${table.name === selected ? 'active' : ''}" href="${href}">${escapeHtml(table.name)}${table.type ? ` <small>${escapeHtml(table.type)}</small>` : ''}</a></li>`;
  }).join('')}</ul>`;
}

function renderShowCreate(statement) {
  if (!statement) return emptyState('No SHOW CREATE TABLE output.');
  return sqlPreviewBlock({ sql: statement, label: 'SHOW CREATE TABLE' });
}

function renderSchema({ connection, table, schema, canAlter }) {
  if (!schema.length) return emptyState('No schema data.');
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  const head = ['Field', 'Type', 'Properties'];
  if (canAlter) head.push('Actions');
  return `${dataTable({
    wrapClass: 'schema-table',
    head,
    rows: schema.map((schemaField) => {
      const cells = [
        `<code>${escapeHtml(schemaField.name)}</code>`,
        escapeHtml(schemaField.type),
        escapeHtml(schemaField.properties)
      ];
      if (canAlter) cells.push(renderColumnActions(basePath, schemaField, schema));
      return cells;
    })
  })}
  ${canAlter ? renderAddColumnForm(basePath) : '<p class="muted">Schema editing is available only for rt tables.</p>'}`;
}

function renderDataGrid({ connection, table, columns, rows, page, perPage, search, sort, dir, canWrite }) {
  if (!columns.length) return emptyState('No data columns.');
  const basePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  const head = columns.map((column) => sortLink({ basePath, column, page, perPage, search, sort, dir }));
  if (canWrite) head.push('Actions');
  return dataTable({
    tableClass: 'data-grid',
    head,
    rows: rows.map((row) => {
      const cells = columns.map((column) => codeCell(row[column]));
      if (canWrite) cells.push(renderRowActions(connection, table, row));
      return cells;
    }),
    empty: 'No rows.'
  });
}

function sortLink({ basePath, column, page, perPage, search, sort, dir }) {
  const nextDir = sort === column && dir !== 'desc' ? 'desc' : 'asc';
  const href = urlWithParams(basePath, { page, perPage, q: search, sort: column, dir: nextDir });
  const marker = sort === column ? (dir === 'desc' ? ' desc' : ' asc') : '';
  return `<a href="${escapeAttr(href)}" hx-get="${escapeAttr(href)}" hx-target="#data-panel" hx-swap="outerHTML" hx-push-url="true">${escapeHtml(column)}${escapeHtml(marker)}</a>`;
}

function renderRowActions(connection, table, row) {
  if (row.id === undefined || row.id === null || row.id === '') {
    return '<span class="muted">No id</span>';
  }
  const rowId = encodeURIComponent(String(row.id));
  const tablePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  return `<div class="button-row compact">
    ${button({ label: 'Edit', href: `${tablePath}/rows/${rowId}/edit`, variant: 'secondary' })}
    ${button({ label: 'Delete', href: `${tablePath}/rows/${rowId}/delete`, variant: 'secondary danger-link' })}
  </div>`;
}

function renderColumnActions(basePath, schemaField, schema) {
  if (schemaField.name === 'id') return '<span class="muted">Implicit</span>';
  const encoded = encodeURIComponent(schemaField.name);
  const attributeCount = schema.filter(isAttributeLike).length;
  const canDrop = !(isAttributeLike(schemaField) && attributeCount <= 1);
  return `<div class="button-row compact">
    ${canWidenToBigint(schemaField) ? button({ label: 'Widen to bigint', href: `${basePath}/columns/${encoded}/modify-bigint`, variant: 'secondary' }) : ''}
    ${canDrop ? button({ label: 'Drop', href: `${basePath}/columns/${encoded}/drop`, variant: 'secondary danger-link' }) : '<span class="muted">Last attribute</span>'}
  </div>`;
}

function renderAddColumnForm(basePath) {
  return `<form method="post" action="${basePath}/columns/add" class="stacked-form add-column-form" data-column-kind hx-sync="this:drop">
    <h3>Add column</h3>
    <div class="form-grid">
      ${field({
        label: 'Name',
        control: textInput({ name: 'column_name', attrs: { required: true, pattern: '[A-Za-z_][A-Za-z0-9_]*' } })
      })}
      ${field({
        label: 'Type',
        control: selectInput({ name: 'column_type', value: 'string', options: alterColumnTypes, attrs: { 'data-column-type': true } })
      })}
      ${checkboxCard({ name: 'column_indexed', label: 'indexed', classes: 'checkbox-card column-modifier' })}
      ${checkboxCard({ name: 'column_attribute', label: 'attribute', classes: 'checkbox-card column-modifier' })}
      ${checkboxCard({ name: 'column_secondary_index', label: "secondary_index='1'", classes: 'checkbox-card json-option' })}
    </div>
    <div class="form-actions">
      ${button({ label: 'Preview ADD COLUMN SQL', submit: true, attrs: { name: 'intent', value: 'preview' } })}
    </div>
  </form>`;
}

function renderColumnBuilderRow({ column = {}, index, mode }) {
  const type = column.type || (mode === 'create' ? 'text' : 'string');
  const types = mode === 'create' ? createColumnTypes : alterColumnTypes;
  const prefix = `col_${index}_`;
  return `<div class="column-row" data-column-row>
    <div class="column-row-main">
      ${field({
        label: 'Name',
        control: textInput({ name: `${prefix}name`, value: column.name || '', attrs: { required: true, pattern: '[A-Za-z_][A-Za-z0-9_]*' } })
      })}
      ${field({
        label: 'Type',
        control: selectInput({ name: `${prefix}type`, value: type, options: types, attrs: { 'data-column-type': true } })
      })}
      ${button({ label: 'Remove', variant: 'secondary compact-remove', attrs: { 'data-remove-column': true } })}
    </div>
    <div class="column-flags" data-column-kind>
      ${checkboxCard({
        name: `${prefix}indexed`,
        label: 'indexed',
        checked: Boolean(column.indexed || (!column.type && mode === 'create')),
        classes: 'checkbox-card column-modifier'
      })}
      ${checkboxCard({
        name: `${prefix}stored`,
        label: 'stored',
        checked: Boolean(column.stored || (!column.type && mode === 'create')),
        classes: `checkbox-card column-modifier${mode === 'alter' ? ' hidden' : ''}`
      })}
      ${checkboxCard({
        name: `${prefix}attribute`,
        label: 'attribute',
        checked: Boolean(column.attribute),
        classes: 'checkbox-card column-modifier'
      })}
      ${checkboxCard({
        name: `${prefix}secondary_index`,
        label: "secondary_index='1'",
        checked: Boolean(column.secondary_index),
        classes: 'checkbox-card json-option'
      })}
      <div class="vector-options">
        ${field({ label: 'knn_type', control: textInput({ name: `${prefix}knn_type`, value: column.knn_type || 'hnsw' }) })}
        ${field({ label: 'knn_dims', control: textInput({ name: `${prefix}knn_dims`, value: column.knn_dims || '', attrs: { inputmode: 'numeric' } }) })}
        ${field({ label: 'similarity', control: selectInput({ name: `${prefix}hnsw_similarity`, value: column.hnsw_similarity || 'l2', options: ['l2', 'ip', 'cosine'] }) })}
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

function isAttributeLike(schemaField) {
  const type = String(schemaField.type || '').toLowerCase();
  if (schemaField.name === 'id') return false;
  if (type.includes('text')) return String(schemaField.properties || '').toLowerCase().includes('attribute');
  return true;
}

function canWidenToBigint(schemaField) {
  return ['int', 'integer', 'uint'].includes(String(schemaField.type || '').toLowerCase());
}

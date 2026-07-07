import { columnNames, escapeAttr, escapeHtml, urlWithParams, valueToText } from '../html.js';

// ---------------------------------------------------------------------------
// The shared component layer. Every screen is assembled ONLY from the pieces
// in this file (buttons, fields, tables, pagination, alerts/toasts, the SQL
// preview + confirm form, and empty states), so structure and wording stay
// consistent across pages instead of being re-remembered per view.
// ---------------------------------------------------------------------------

export function attrString(map = {}) {
  return Object.entries(map)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => (value === true ? ` ${key}` : ` ${key}="${escapeAttr(value)}"`))
    .join('');
}

// --- Buttons ---------------------------------------------------------------

export function button({ label, href = '', submit = false, variant = '', title = '', disabled = false, attrs = {} }) {
  const classes = variant ? ` ${variant}` : '';
  if (href) {
    if (disabled) {
      return `<span class="button disabled${classes}"${title ? ` title="${escapeAttr(title)}"` : ''}>${escapeHtml(label)}</span>`;
    }
    return `<a class="button${classes}" href="${escapeAttr(href)}"${attrString(attrs)}>${escapeHtml(label)}</a>`;
  }
  return `<button type="${submit ? 'submit' : 'button'}"${variant ? ` class="${variant}"` : ''}${title ? ` title="${escapeAttr(title)}"` : ''}${attrString(attrs)}>${escapeHtml(label)}</button>`;
}

// --- Form fields -------------------------------------------------------------

export function field({ label, hint = '', control }) {
  return `<label>
    <span>${escapeHtml(label)}${hint ? ` <small>${escapeHtml(hint)}</small>` : ''}</span>
    ${control}
  </label>`;
}

export function textInput({ name, value = '', type = '', attrs = {} }) {
  return `<input${type ? ` type="${escapeAttr(type)}"` : ''} name="${escapeAttr(name)}" value="${escapeAttr(value)}"${attrString(attrs)}>`;
}

export function selectInput({ name, value = '', options = [], attrs = {} }) {
  const rendered = options.map((option) => {
    const item = typeof option === 'object' && option !== null ? option : { value: option, label: option };
    const selected = String(item.value) === String(value) ? 'selected' : '';
    return `<option value="${escapeAttr(item.value)}" ${selected}>${escapeHtml(item.label)}</option>`;
  }).join('');
  return `<select name="${escapeAttr(name)}"${attrString(attrs)}>${rendered}</select>`;
}

export function textareaInput({ name, value = '', rows = 4, attrs = {} }) {
  return `<textarea name="${escapeAttr(name)}" rows="${escapeAttr(rows)}"${attrString(attrs)}>${escapeHtml(value)}</textarea>`;
}

export function checkboxCard({ name, label, checked = false, value = '1', classes = 'checkbox-card', attrs = {} }) {
  return `<label class="${escapeAttr(classes)}">
    <input type="checkbox" name="${escapeAttr(name)}" value="${escapeAttr(value)}" ${checked ? 'checked' : ''}${attrString(attrs)}>
    <span>${escapeHtml(label)}</span>
  </label>`;
}

// --- Alerts & toasts ---------------------------------------------------------

export function renderAlert(message, type = 'error') {
  if (!message) return '';
  const role = type === 'error' ? 'alert' : 'status';
  return `<div class="alert alert-${escapeAttr(type)}" role="${role}">${escapeHtml(message)}</div>`;
}

export function renderMessages(messages = []) {
  if (!messages.length) return '';
  return `<div class="message-stack">${messages.map((message) => {
    const type = message.type === 'warning' ? 'warning' : 'error';
    const prefix = message.statement ? `Statement ${message.statement}: ` : '';
    return renderAlert(`${prefix}${message.message}`, type);
  }).join('')}</div>`;
}

// Toasts land in the fixed #toast-region declared once in the layout. Server
// responses append them via an htmx out-of-band swap so errors/warnings and
// success feedback always surface in the same place without replacing the
// content the user is looking at.
export function renderToast({ type = 'success', message, statement }, { oob = false } = {}) {
  const kind = type === 'warning' ? 'warning' : type === 'error' ? 'error' : 'success';
  const role = kind === 'error' ? 'alert' : 'status';
  const prefix = statement ? `Statement ${statement}: ` : '';
  return `<div class="toast alert alert-${kind}"${oob ? ' hx-swap-oob="afterbegin:#toast-region"' : ''} role="${role}">
    <span class="toast-message">${escapeHtml(`${prefix}${message}`)}</span>
    <button type="button" class="toast-close" data-toast-close aria-label="Dismiss">&times;</button>
  </div>`;
}

export function renderToastsOob(toasts = []) {
  return toasts.map((toast) => renderToast(toast, { oob: true })).join('');
}

export function renderToastRegion() {
  return '<div id="toast-region" class="toast-region" aria-live="polite"></div>';
}

// --- Empty states ------------------------------------------------------------

export function emptyState(text) {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

// --- Tables --------------------------------------------------------------------

// head / rows carry PRE-RENDERED (already escaped) cell HTML.
export function dataTable({ head = [], rows = [], empty = 'No rows', tableClass = '', wrapClass = '' }) {
  return `<div class="table-wrap${wrapClass ? ` ${wrapClass}` : ''}"><table${tableClass ? ` class="${tableClass}"` : ''}>
      <thead><tr>${head.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}" class="empty">${escapeHtml(empty)}</td></tr>`}
      </tbody>
    </table></div>`;
}

export function codeCell(value) {
  return `<code>${escapeHtml(valueToText(value))}</code>`;
}

// --- Pagination -----------------------------------------------------------------

// Pagination swaps only the surrounding data panel (hx-target) so the rest of
// the page keeps its scroll position; hx-push-url keeps the page deep-linkable.
export function renderPagination({ basePath, page, maxPage, perPage, search, sort, dir, hxTarget = '#data-panel' }) {
  if (maxPage <= 1) return '';
  const previous = Math.max(1, page - 1);
  const next = Math.min(maxPage, page + 1);
  const link = (targetPage, label, isEdge) => {
    const href = urlWithParams(basePath, { page: targetPage, perPage, q: search, sort, dir });
    return `<a class="button secondary ${isEdge ? 'disabled' : ''}" href="${escapeAttr(href)}" hx-get="${escapeAttr(href)}" hx-target="${escapeAttr(hxTarget)}" hx-swap="outerHTML" hx-push-url="true">${escapeHtml(label)}</a>`;
  };
  return `<nav class="pagination">
    ${link(previous, 'Previous', page === 1)}
    <span>Page ${escapeHtml(page)} of ${escapeHtml(maxPage)}</span>
    ${link(next, 'Next', page === maxPage)}
  </nav>`;
}

// --- Result sets (SQL console + write results) -----------------------------------

export function renderResultSet(resultSet, index = 0) {
  const columns = columnNames(resultSet);
  const rows = Array.isArray(resultSet?.data) ? resultSet.data : [];
  const total = resultSet?.total ?? rows.length;

  return `<section class="result-set">
    <header class="result-heading">
      <h3>Result ${index + 1}</h3>
      <span>${escapeHtml(total)} row${Number(total) === 1 ? '' : 's'}</span>
    </header>
    ${renderMessages([
      resultSet?.error ? { type: 'error', statement: index + 1, message: resultSet.error } : null,
      resultSet?.warning ? { type: 'warning', statement: index + 1, message: resultSet.warning } : null
    ].filter(Boolean))}
    ${columns.length ? dataTable({
      head: columns.map((column) => escapeHtml(column)),
      rows: rows.map((row) => columns.map((column) => codeCell(row[column]))),
      empty: 'No rows'
    }) : emptyState('No tabular data returned.')}
  </section>`;
}

export function renderResultSets(results = []) {
  if (!Array.isArray(results) || results.length === 0) {
    return emptyState('No results.');
  }
  return results.map(renderResultSet).join('');
}

export function renderStatusTable(resultSet) {
  const rows = Array.isArray(resultSet?.data) ? resultSet.data : [];
  if (!rows.length) return '';

  // `SHOW TABLE <t> STATUS` returns one { Variable_name, Value } pair per row
  // (dozens of them). Render every pair, not just the first row.
  const looksLikeVariables = rows.every(
    (row) => row && typeof row === 'object' && 'Variable_name' in row && 'Value' in row
  );
  const pairs = looksLikeVariables
    ? rows.map((row) => [row.Variable_name, row.Value])
    : Object.entries(rows[0]);

  return `<dl class="status-grid">${pairs.map(([key, value]) => `
    <div><dt>${escapeHtml(valueToText(key))}</dt><dd>${escapeHtml(valueToText(value))}</dd></div>
  `).join('')}</dl>`;
}

// --- Operation result page ---------------------------------------------------------

export function renderOperationPage({ title, message, messages = [], backHref = '/' }) {
  return `<section class="panel narrow">
    <h1>${escapeHtml(title)}</h1>
    ${message ? `<p>${escapeHtml(message)}</p>` : ''}
    ${renderMessages(messages)}
    <p>${button({ label: 'Back', href: backHref })}</p>
  </section>`;
}

export function renderHiddenFields(values = {}) {
  return Object.entries(values).map(([key, value]) => (
    `<input type="hidden" name="${escapeAttr(key)}" value="${escapeAttr(valueToText(value))}">`
  )).join('');
}

// --- SQL preview block + destructive confirm form -----------------------------------

export function sqlPreviewBlock({ sql, label = 'SQL preview', rows = 6 }) {
  return `<label class="sql-preview">
    <span>${escapeHtml(label)}</span>
    <textarea readonly rows="${escapeAttr(rows)}">${escapeHtml(sql)}</textarea>
  </label>`;
}

// The confirm step for every destructive statement: shows the exact SQL that
// will run, requires an explicit confirm (data-confirm -> window.confirm), and
// echoes the SQL back so the server can reject a stale preview.
export function renderSqlPreviewForm({
  title,
  sql,
  action,
  hidden = {},
  submitLabel = 'Run',
  destructive = false,
  message = '',
  backHref = '/'
}) {
  return `<section class="panel narrow">
    <p><a href="${escapeAttr(backHref)}">Back</a></p>
    <h1>${escapeHtml(title)}</h1>
    ${message ? `<p class="muted">${escapeHtml(message)}</p>` : ''}
    ${sqlPreviewBlock({ sql })}
    <form method="post" action="${escapeAttr(action)}" class="stacked-form" hx-sync="this:drop" ${destructive ? `data-confirm="${escapeAttr(submitLabel)}?"` : ''}>
      ${renderHiddenFields(hidden)}
      <input type="hidden" name="intent" value="execute">
      <input type="hidden" name="sql_preview" value="${escapeAttr(sql)}">
      <div class="form-actions">
        ${button({ label: submitLabel, submit: true, variant: destructive ? 'danger' : '' })}
        ${button({ label: 'Cancel', href: backHref, variant: 'secondary' })}
      </div>
    </form>
  </section>`;
}

// --- Type-aware row form -------------------------------------------------------------

function isUnreadableField(field) {
  const type = String(field.type || '').toLowerCase();
  const properties = String(field.properties || '').toLowerCase();
  return type.includes('text') && !properties.includes('stored');
}

export function renderRowForm({ action, mode, fields, values = {}, error = '' }) {
  const submitLabel = mode === 'edit' ? 'Save row' : 'Insert row';
  const visibleFields = mode === 'insert'
    ? fields.filter((rowField) => rowField.name !== 'id')
    : fields;
  // Indexed-only (non-stored) text fields cannot be read back, so the form
  // starts empty for them. Attribute-only edits are saved with an in-place
  // UPDATE that preserves their indexed content; changing any full-text field
  // switches to REPLACE, which resends the whole document and erases whatever
  // is left empty here. Warn instead of losing data quietly.
  const unreadable = mode === 'edit' ? fields.filter(isUnreadableField).map((rowField) => rowField.name) : [];
  const unreadableWarning = unreadable.length
    ? renderAlert(`${unreadable.join(', ')}: indexed but not stored, so the current value cannot be shown. Attribute-only edits keep ${unreadable.length === 1 ? 'its' : 'their'} indexed content; changing any full-text field replaces the whole row and erases ${unreadable.length === 1 ? 'this field' : 'these fields'} unless you retype ${unreadable.length === 1 ? 'it' : 'them'}.`, 'warning')
    : '';
  return `<form method="post" action="${escapeAttr(action)}" class="stacked-form row-form" hx-sync="this:drop">
    ${renderAlert(error)}
    ${unreadableWarning}
    ${visibleFields.map((rowField) => renderField(rowField, values[rowField.name], mode)).join('')}
    <div class="form-actions">
      ${button({ label: submitLabel, submit: true })}
    </div>
  </form>`;
}

function renderField(rowField, value, mode) {
  const name = rowField.name;
  const type = rowField.type.toLowerCase();
  const readonlyId = name === 'id' && mode === 'edit';
  const textValue = valueToText(value);
  let control = '';

  if (name === 'id') {
    control = textInput({
      name,
      value: textValue,
      attrs: {
        inputmode: 'numeric',
        pattern: '[0-9]*',
        readonly: readonlyId,
        placeholder: mode === 'insert' ? 'Auto' : ''
      }
    });
  } else if (type.includes('bool')) {
    const checked = ['1', 'true', 'yes', 'on'].includes(String(textValue).toLowerCase());
    control = `<input type="hidden" name="${escapeAttr(name)}" value="0"><span class="checkbox-line"><input type="checkbox" name="${escapeAttr(name)}" value="1" ${checked ? 'checked' : ''}> <span>True</span></span>`;
  } else if (type.includes('json')) {
    control = textareaInput({ name, value: textValue, rows: 6, attrs: { 'data-json-input': true } });
  } else if (type.includes('timestamp')) {
    control = textInput({ name, value: timestampInputValue(value), type: 'datetime-local', attrs: { step: '1' } });
  } else if (type.includes('float_vector')) {
    // Must be checked before float/int: DESC reports the type as float_vector
    // and a number input cannot hold a comma-separated vector.
    control = textareaInput({ name, value: textValue, rows: 3, attrs: { placeholder: '0.1,0.2,0.3 or [0.1,0.2,0.3]' } });
  } else if (type.includes('multi') || type.includes('mva')) {
    // DESC reports MVA columns as mva / mva64.
    control = textareaInput({ name, value: textValue, rows: 3, attrs: { placeholder: '1,2,3 or [1,2,3]' } });
  } else if (type.includes('bigint')) {
    control = textInput({ name, value: textValue, attrs: { inputmode: 'numeric', pattern: '-?[0-9]*' } });
  } else if (type.includes('float')) {
    control = textInput({ name, value: textValue, type: 'number', attrs: { step: 'any' } });
  } else if (type.includes('int') || type === 'uint') {
    control = textInput({ name, value: textValue, type: 'number', attrs: { step: '1' } });
  } else if (type.includes('text')) {
    control = textareaInput({ name, value: textValue, rows: 4 });
  } else {
    control = textInput({ name, value: textValue });
  }

  return field({
    label: name,
    hint: `${rowField.type}${rowField.properties ? `, ${rowField.properties}` : ''}`,
    control
  });
}

function timestampInputValue(value) {
  if (value === null || value === undefined || value === '') return '';
  const raw = String(value);
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const date = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(raw);
  if (!Number.isFinite(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  // Keep seconds (slice to :SS, input has step="1"); cutting at minutes made
  // an untouched edit save round a stored timestamp down.
  return new Date(date.getTime() - offset).toISOString().slice(0, 19);
}

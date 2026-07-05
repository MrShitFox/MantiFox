import { columnNames, escapeAttr, escapeHtml, valueToText } from '../html.js';

export function renderAlert(message, type = 'error') {
  if (!message) return '';
  return `<div class="alert alert-${escapeAttr(type)}">${escapeHtml(message)}</div>`;
}

export function renderMessages(messages = []) {
  if (!messages.length) return '';
  return `<div class="message-stack">${messages.map((message) => {
    const type = message.type === 'warning' ? 'warning' : 'error';
    const prefix = message.statement ? `Statement ${message.statement}: ` : '';
    return renderAlert(`${prefix}${message.message}`, type);
  }).join('')}</div>`;
}

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
    ${columns.length ? `<div class="table-wrap"><table>
      <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.length ? rows.map((row) => `<tr>${columns.map((column) => `<td><code>${escapeHtml(valueToText(row[column]))}</code></td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}" class="empty">No rows</td></tr>`}
      </tbody>
    </table></div>` : '<p class="empty">No tabular data returned.</p>'}
  </section>`;
}

export function renderResultSets(results = []) {
  if (!Array.isArray(results) || results.length === 0) {
    return '<p class="empty">No results.</p>';
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

export function renderOperationPage({ title, message, messages = [], backHref = '/' }) {
  return `<section class="panel narrow">
    <h1>${escapeHtml(title)}</h1>
    ${message ? `<p>${escapeHtml(message)}</p>` : ''}
    ${renderMessages(messages)}
    <p><a class="button" href="${escapeAttr(backHref)}">Back</a></p>
  </section>`;
}

export function renderHiddenFields(values = {}) {
  return Object.entries(values).map(([key, value]) => (
    `<input type="hidden" name="${escapeAttr(key)}" value="${escapeAttr(valueToText(value))}">`
  )).join('');
}

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
    <label class="sql-preview">
      <span>SQL preview</span>
      <textarea readonly rows="6">${escapeHtml(sql)}</textarea>
    </label>
    <form method="post" action="${escapeAttr(action)}" class="stacked-form" ${destructive ? `data-confirm="${escapeAttr(submitLabel)}?"` : ''}>
      ${renderHiddenFields(hidden)}
      <input type="hidden" name="intent" value="execute">
      <input type="hidden" name="sql_preview" value="${escapeAttr(sql)}">
      <div class="form-actions">
        <button class="${destructive ? 'danger' : ''}" type="submit">${escapeHtml(submitLabel)}</button>
        <a class="button secondary" href="${escapeAttr(backHref)}">Cancel</a>
      </div>
    </form>
  </section>`;
}

function isUnreadableField(field) {
  const type = String(field.type || '').toLowerCase();
  const properties = String(field.properties || '').toLowerCase();
  return type.includes('text') && !properties.includes('stored');
}

export function renderRowForm({ action, mode, fields, values = {}, error = '' }) {
  const submitLabel = mode === 'edit' ? 'Save row' : 'Insert row';
  const visibleFields = mode === 'insert'
    ? fields.filter((field) => field.name !== 'id')
    : fields;
  // Saving REPLACEs the whole document, but indexed-only (non-stored) text
  // fields cannot be read back, so the form starts empty for them and saving
  // silently erases their indexed content. Warn instead of losing data quietly.
  const unreadable = mode === 'edit' ? fields.filter(isUnreadableField).map((field) => field.name) : [];
  const unreadableWarning = unreadable.length
    ? renderAlert(`${unreadable.join(', ')}: indexed but not stored, so the current value cannot be shown. Saving replaces the whole row - leaving ${unreadable.length === 1 ? 'this field' : 'these fields'} empty erases ${unreadable.length === 1 ? 'its' : 'their'} indexed content.`, 'warning')
    : '';
  return `<form method="post" action="${escapeAttr(action)}" class="stacked-form row-form">
    ${renderAlert(error)}
    ${unreadableWarning}
    ${visibleFields.map((field) => renderField(field, values[field.name], mode)).join('')}
    <div class="form-actions">
      <button type="submit">${escapeHtml(submitLabel)}</button>
    </div>
  </form>`;
}

function renderField(field, value, mode) {
  const name = field.name;
  const type = field.type.toLowerCase();
  const readonlyId = name === 'id' && mode === 'edit';
  const readonly = readonlyId ? 'readonly' : '';
  const textValue = valueToText(value);
  let control = '';

  if (name === 'id') {
    control = `<input name="${escapeAttr(name)}" value="${escapeAttr(textValue)}" inputmode="numeric" pattern="[0-9]*" ${readonly} placeholder="${mode === 'insert' ? 'Auto' : ''}">`;
  } else if (type.includes('bool')) {
    const checked = ['1', 'true', 'yes', 'on'].includes(String(textValue).toLowerCase()) ? 'checked' : '';
    control = `<input type="hidden" name="${escapeAttr(name)}" value="0"><span class="checkbox-line"><input type="checkbox" name="${escapeAttr(name)}" value="1" ${checked}> <span>True</span></span>`;
  } else if (type.includes('json')) {
    control = `<textarea name="${escapeAttr(name)}" rows="6" data-json-input>${escapeHtml(textValue)}</textarea>`;
  } else if (type.includes('timestamp')) {
    control = `<input type="datetime-local" step="1" name="${escapeAttr(name)}" value="${escapeAttr(timestampInputValue(value))}">`;
  } else if (type.includes('float_vector')) {
    // Must be checked before float/int: DESC reports the type as float_vector
    // and a number input cannot hold a comma-separated vector.
    control = `<textarea name="${escapeAttr(name)}" rows="3" placeholder="0.1,0.2,0.3 or [0.1,0.2,0.3]">${escapeHtml(textValue)}</textarea>`;
  } else if (type.includes('multi') || type.includes('mva')) {
    // DESC reports MVA columns as mva / mva64.
    control = `<textarea name="${escapeAttr(name)}" rows="3" placeholder="1,2,3 or [1,2,3]">${escapeHtml(textValue)}</textarea>`;
  } else if (type.includes('bigint')) {
    control = `<input name="${escapeAttr(name)}" inputmode="numeric" pattern="-?[0-9]*" value="${escapeAttr(textValue)}">`;
  } else if (type.includes('float')) {
    control = `<input type="number" step="any" name="${escapeAttr(name)}" value="${escapeAttr(textValue)}">`;
  } else if (type.includes('int') || type === 'uint') {
    control = `<input type="number" step="1" name="${escapeAttr(name)}" value="${escapeAttr(textValue)}">`;
  } else if (type.includes('text')) {
    control = `<textarea name="${escapeAttr(name)}" rows="4">${escapeHtml(textValue)}</textarea>`;
  } else {
    control = `<input name="${escapeAttr(name)}" value="${escapeAttr(textValue)}">`;
  }

  return `<label>
    <span>${escapeHtml(name)} <small>${escapeHtml(field.type)}${field.properties ? `, ${escapeHtml(field.properties)}` : ''}</small></span>
    ${control}
  </label>`;
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

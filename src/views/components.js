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
  const row = resultSet?.data?.[0];
  if (!row) return '';
  return `<dl class="status-grid">${Object.entries(row).map(([key, value]) => `
    <div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(valueToText(value))}</dd></div>
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

export function renderRowForm({ action, mode, fields, values = {}, error = '' }) {
  const submitLabel = mode === 'edit' ? 'Save row' : 'Insert row';
  return `<form method="post" action="${escapeAttr(action)}" class="stacked-form row-form">
    ${renderAlert(error)}
    ${fields.map((field) => renderField(field, values[field.name], mode)).join('')}
    <div class="form-actions">
      <button type="submit">${escapeHtml(submitLabel)}</button>
    </div>
  </form>`;
}

function renderField(field, value, mode) {
  const name = field.name;
  const type = field.type.toLowerCase();
  const readonlyId = mode === 'edit' && name === 'id';
  const control = type.includes('text') || type.includes('json')
    ? `<textarea name="${escapeAttr(name)}" rows="3" ${readonlyId ? 'readonly' : ''}>${escapeHtml(valueToText(value))}</textarea>`
    : `<input name="${escapeAttr(name)}" value="${escapeAttr(valueToText(value))}" ${readonlyId ? 'readonly' : ''}>`;

  return `<label>
    <span>${escapeHtml(name)} <small>${escapeHtml(field.type)}${field.properties ? `, ${escapeHtml(field.properties)}` : ''}</small></span>
    ${control}
  </label>`;
}

import { escapeAttr, escapeHtml } from '../html.js';
import { connectionBaseUrl } from '../manticore.js';
import { renderAlert } from './components.js';
import { layout } from './layout.js';

export function renderDashboardPage({ connections = [], error = '' } = {}) {
  return layout({
    title: 'Connections',
    body: `<section class="page-heading">
      <div>
        <h1>Connections</h1>
        <p>Save Manticore HTTP API endpoints and open them for browsing or SQL.</p>
      </div>
    </section>
    ${renderAlert(error)}
    <div class="dashboard-grid">
      <section class="panel">
        <h2>Add connection</h2>
        ${renderConnectionForm({ action: '/connections', submitLabel: 'Save connection' })}
      </section>
      <section class="panel">
        <h2>Saved connections</h2>
        ${connections.length ? `<div class="connection-list">${connections.map(renderConnectionCard).join('')}</div>` : '<p class="empty">No connections yet.</p>'}
      </section>
    </div>`
  });
}

export function renderEditConnectionPage({ connection, error = '' }) {
  return layout({
    title: `Edit ${connection.name}`,
    body: `<section class="panel narrow">
      <h1>Edit connection</h1>
      ${renderConnectionForm({
        connection,
        action: `/connections/${connection.id}/edit`,
        submitLabel: 'Save changes',
        error
      })}
    </section>`
  });
}

function renderConnectionCard(connection) {
  return `<article class="connection-card">
    <header>
      <h3>${escapeHtml(connection.name)}</h3>
      <code>${escapeHtml(connectionBaseUrl(connection))}</code>
    </header>
    <p>Auth: ${escapeHtml(connection.auth_type)}</p>
    <div class="button-row">
      <a class="button" href="/connections/${connection.id}">Browse</a>
      <a class="button secondary" href="/connections/${connection.id}/console">SQL</a>
      <a class="button secondary" href="/connections/${connection.id}/edit">Edit</a>
      <button type="button" class="secondary" data-test-connection="${connection.id}">Test</button>
      <form method="post" action="/connections/${connection.id}/delete" data-confirm="Delete this connection?">
        <button type="submit" class="danger">Delete</button>
      </form>
    </div>
    <p class="test-output" data-test-output="${connection.id}"></p>
  </article>`;
}

function renderConnectionForm({ connection = {}, action, submitLabel, error = '' }) {
  const authType = connection.auth_type || 'none';
  return `<form method="post" action="${escapeAttr(action)}" class="stacked-form connection-form">
    ${renderAlert(error)}
    <div class="two-cols">
      <label>
        <span>Name</span>
        <input name="name" value="${escapeAttr(connection.name || '')}" placeholder="Production search" required>
      </label>
      <label>
        <span>Scheme</span>
        <select name="scheme">
          <option value="http" ${connection.scheme === 'https' ? '' : 'selected'}>http</option>
          <option value="https" ${connection.scheme === 'https' ? 'selected' : ''}>https</option>
        </select>
      </label>
    </div>
    <div class="two-cols">
      <label>
        <span>Host</span>
        <input name="host" value="${escapeAttr(connection.host || '')}" placeholder="192.168.1.75" required>
      </label>
      <label>
        <span>HTTP port</span>
        <input name="port" inputmode="numeric" value="${escapeAttr(connection.port || '')}" placeholder="9318" required>
      </label>
    </div>
    <label>
      <span>Authentication</span>
      <select name="auth_type">
        <option value="none" ${authType === 'none' ? 'selected' : ''}>None</option>
        <option value="basic" ${authType === 'basic' ? 'selected' : ''}>Basic</option>
        <option value="bearer" ${authType === 'bearer' ? 'selected' : ''}>Bearer token</option>
      </select>
    </label>
    <div class="auth-basic">
      <div class="two-cols">
        <label>
          <span>Username</span>
          <input name="username" value="${escapeAttr(connection.username || '')}">
        </label>
        <label>
          <span>Password ${connection.id ? '<small>leave blank to keep</small>' : ''}</span>
          <input type="password" name="password" autocomplete="new-password">
        </label>
      </div>
    </div>
    <div class="auth-bearer">
      <label>
        <span>Bearer token ${connection.id ? '<small>leave blank to keep</small>' : ''}</span>
        <input type="password" name="bearer_token" autocomplete="off">
      </label>
    </div>
    <div class="form-actions">
      <button type="submit">${escapeHtml(submitLabel)}</button>
    </div>
  </form>`;
}

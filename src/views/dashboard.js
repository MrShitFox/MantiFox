import { escapeAttr, escapeHtml } from '../html.js';
import { connectionBaseUrl } from '../manticore.js';
import { button, emptyState, field, renderAlert, selectInput, textInput } from './components.js';

export function renderDashboardPage({ connections = [], error = '', values = {} } = {}) {
  return {
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
        ${renderConnectionForm({ connection: values, action: '/connections', submitLabel: 'Save connection' })}
      </section>
      <section class="panel">
        <h2>Saved connections</h2>
        ${connections.length ? `<div class="connection-list">${connections.map(renderConnectionCard).join('')}</div>` : emptyState('No connections yet.')}
      </section>
    </div>`
  };
}

export function renderEditConnectionPage({ connection, error = '' }) {
  return {
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
  };
}

function renderConnectionCard(connection) {
  return `<article class="connection-card">
    <header>
      <h3>${escapeHtml(connection.name)}</h3>
      <code>${escapeHtml(connectionBaseUrl(connection))}</code>
    </header>
    <p>Auth: ${escapeHtml(connection.auth_type)}</p>
    <div class="button-row">
      ${button({ label: 'Browse', href: `/connections/${connection.id}` })}
      ${button({ label: 'SQL', href: `/connections/${connection.id}/console`, variant: 'secondary' })}
      ${button({ label: 'Edit', href: `/connections/${connection.id}/edit`, variant: 'secondary' })}
      ${button({
        label: 'Test',
        variant: 'secondary',
        attrs: {
          'hx-post': `/connections/${connection.id}/test`,
          'hx-target': `#test-output-${connection.id}`,
          'hx-swap': 'outerHTML',
          'hx-disabled-elt': 'this'
        }
      })}
      <form method="post" action="/connections/${connection.id}/delete" data-confirm="Delete this connection?" hx-sync="this:drop">
        ${button({ label: 'Delete', submit: true, variant: 'danger' })}
      </form>
    </div>
    <p class="test-output" id="test-output-${connection.id}"></p>
  </article>`;
}

function renderConnectionForm({ connection = {}, action, submitLabel, error = '' }) {
  const authType = connection.auth_type || 'none';
  return `<form method="post" action="${escapeAttr(action)}" class="stacked-form connection-form" hx-sync="this:drop">
    ${renderAlert(error)}
    <div class="two-cols">
      ${field({
        label: 'Name',
        control: textInput({ name: 'name', value: connection.name || '', attrs: { placeholder: 'Production search', required: true } })
      })}
      ${field({
        label: 'Scheme',
        control: selectInput({ name: 'scheme', value: connection.scheme === 'https' ? 'https' : 'http', options: ['http', 'https'] })
      })}
    </div>
    <div class="two-cols">
      ${field({
        label: 'Host',
        control: textInput({ name: 'host', value: connection.host || '', attrs: { placeholder: '192.168.1.75', required: true } })
      })}
      ${field({
        label: 'HTTP port',
        control: textInput({ name: 'port', value: connection.port || '', attrs: { inputmode: 'numeric', placeholder: '9318', required: true } })
      })}
    </div>
    ${field({
      label: 'Authentication',
      control: selectInput({
        name: 'auth_type',
        value: authType,
        options: [
          { value: 'none', label: 'None' },
          { value: 'basic', label: 'Basic' },
          { value: 'bearer', label: 'Bearer token' }
        ]
      })
    })}
    <div class="auth-basic">
      <div class="two-cols">
        ${field({
          label: 'Username',
          control: textInput({ name: 'username', value: connection.username || '' })
        })}
        ${field({
          label: 'Password',
          hint: connection.id ? 'leave blank to keep' : '',
          control: textInput({ name: 'password', type: 'password', attrs: { autocomplete: 'new-password' } })
        })}
      </div>
    </div>
    <div class="auth-bearer">
      ${field({
        label: 'Bearer token',
        hint: connection.id ? 'leave blank to keep' : '',
        control: textInput({ name: 'bearer_token', type: 'password', attrs: { autocomplete: 'off' } })
      })}
    </div>
    <div class="form-actions">
      ${button({ label: submitLabel, submit: true })}
    </div>
  </form>`;
}

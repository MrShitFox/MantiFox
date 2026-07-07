import { escapeAttr, escapeHtml } from '../html.js';
import { button, renderAlert, renderResultSets } from './components.js';

export function renderConsolePage({ connection, sql = 'SHOW TABLES', results = null, error = '' }) {
  const action = `/connections/${connection.id}/console`;
  return {
    title: `SQL console - ${connection.name}`,
    body: `<section class="page-heading">
      <div>
        <p><a href="/connections/${connection.id}">${escapeHtml(connection.name)}</a></p>
        <h1>SQL console</h1>
      </div>
    </section>
    <section class="panel">
      <form method="post" action="${escapeAttr(action)}" class="stacked-form sql-console" hx-post="${escapeAttr(action)}" hx-target="#console-results" hx-swap="outerHTML" hx-sync="this:drop" hx-indicator="#console-indicator">
        <label>
          <span>SQL sent to <code>/sql?mode=raw</code></span>
          <textarea name="sql" rows="10" spellcheck="false">${escapeHtml(sql)}</textarea>
        </label>
        <div class="form-actions">
          ${button({ label: 'Run SQL', submit: true })}
          <span id="console-indicator" class="htmx-indicator muted"><span class="spinner"></span>Running…</span>
        </div>
      </form>
    </section>
    <section class="panel">
      <h2>Results</h2>
      ${renderConsoleResults({ results, error })}
    </section>`
  };
}

// The #console-results fragment htmx swaps after each run. `error` covers
// request-level failures (unreachable node); per-statement error/warning render
// inside each result set exactly like they always have.
export function renderConsoleResults({ results = null, error = '' } = {}) {
  if (error) {
    return `<div id="console-results">${renderAlert(error)}</div>`;
  }
  if (!results) {
    return '<div id="console-results" class="results-placeholder empty">Run a query to see results.</div>';
  }
  return `<div id="console-results">${renderResultSets(results)}</div>`;
}

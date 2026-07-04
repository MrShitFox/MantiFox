import { escapeAttr, escapeHtml } from '../html.js';
import { layout } from './layout.js';

export function renderConsolePage({ connection }) {
  return layout({
    title: `SQL console - ${connection.name}`,
    body: `<section class="page-heading">
      <div>
        <p><a href="/connections/${connection.id}">${escapeHtml(connection.name)}</a></p>
        <h1>SQL console</h1>
      </div>
    </section>
    <section class="panel">
      <form data-sql-console="${escapeAttr(connection.id)}" class="stacked-form sql-console">
        <label>
          <span>SQL sent to <code>/sql?mode=raw</code></span>
          <textarea name="sql" rows="10" spellcheck="false">SHOW TABLES</textarea>
        </label>
        <div class="form-actions">
          <button type="submit">Run SQL</button>
        </div>
      </form>
    </section>
    <section class="panel">
      <h2>Results</h2>
      <div data-sql-results class="results-placeholder empty">Run a query to see results.</div>
    </section>`
  });
}

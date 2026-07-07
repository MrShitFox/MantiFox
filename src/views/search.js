import { escapeAttr, escapeHtml, valueToText } from '../html.js';
import {
  defaultRanker,
  filterableFields,
  highlightAfter,
  highlightBefore,
  isTextField,
  maxBrowseWindow,
  searchFacetLimit,
  searchRankers,
  storedTextFields,
  textFields
} from '../manticore.js';
import {
  button,
  checkboxCard,
  emptyState,
  field,
  renderAlert,
  renderMessages,
  selectInput,
  textInput
} from './components.js';

// ---------------------------------------------------------------------------
// The Search screen (§4.7). One GET route carries the whole search state in
// the URL; the form swaps only #search-results (plus an out-of-band update of
// the #filter-block chips inside the form), so typing, options and scroll
// survive every query, facet click and page turn.
// ---------------------------------------------------------------------------

export const searchDefaultPerPage = 10;

export function searchBasePath(connection, table) {
  return `/connections/${connection.id}/tables/${encodeURIComponent(table)}/search`;
}

// Canonical URL for a given search state (facet clicks, chip removal and
// pagination are plain links built from this). Only non-default values are
// emitted so pushed URLs stay readable.
export function searchStateParams(state, overrides = {}) {
  const merged = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (merged.q) params.set('q', merged.q);
  if (merged.mode === 'advanced') params.set('mode', 'advanced');
  for (const name of merged.fields || []) params.append('field', name);
  if (merged.ranker && merged.ranker !== defaultRanker) params.set('ranker', merged.ranker);
  for (const [name, value] of Object.entries(merged.weights || {})) {
    if (String(value ?? '').trim() !== '') params.set(`w_${name}`, String(value).trim());
  }
  if (merged.facet) params.set('facet', merged.facet);
  for (const filter of merged.filters || []) {
    params.append('f', `${filter.attr}|${filter.op}|${filter.value}`);
  }
  if (merged.fuzzy) {
    params.set('fuzzy', '1');
    if (String(merged.distance ?? '').trim() !== '') params.set('distance', String(merged.distance).trim());
    if (merged.preserve) params.set('preserve', '1');
    if (merged.layouts) params.set('layouts', merged.layouts);
  }
  if (merged.perPage && merged.perPage !== searchDefaultPerPage) params.set('perPage', String(merged.perPage));
  if (merged.page && merged.page > 1) params.set('page', String(merged.page));
  return params;
}

export function searchUrl(basePath, state, overrides = {}) {
  const query = searchStateParams(state, overrides).toString();
  return query ? `${basePath}?${query}` : basePath;
}

function resultsLinkAttrs(href) {
  return ` hx-get="${escapeAttr(href)}" hx-target="#search-results" hx-swap="outerHTML" hx-push-url="true"`;
}

// --- page ------------------------------------------------------------------

export function renderSearchPage({ connection, table, profile, state, results }) {
  const basePath = searchBasePath(connection, table);
  const tablePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  const title = profile.hasText ? `Search ${table}` : `Filter ${table}`;

  return {
    title: `${title} - ${connection.name}`,
    body: `<section class="page-heading">
      <div>
        <p><a href="/connections/${connection.id}">${escapeHtml(connection.name)}</a> &#9656; <a href="${escapeAttr(tablePath)}">${escapeHtml(table)}</a></p>
        <h1>${escapeHtml(profile.hasText ? 'Search' : 'Filter rows')}</h1>
      </div>
      <div class="button-row">
        ${button({ label: 'Browse table', href: tablePath, variant: 'secondary' })}
        ${button({ label: 'SQL console', href: `/connections/${connection.id}/console`, variant: 'secondary' })}
      </div>
    </section>
    ${profile.hasText ? '' : renderAlert('This table has no full-text (text) fields, so MATCH search is unavailable here. You can still filter and facet rows by their attributes below.', 'warning')}
    <section class="panel search-panel">
      ${renderSearchForm({ basePath, profile, state })}
    </section>
    ${renderSearchReproducePanel({ connection, results })}
    ${renderSearchResults({ connection, table, profile, state, results })}`
  };
}

// --- the form ----------------------------------------------------------------

function renderSearchForm({ basePath, profile, state }) {
  const modePill = (value, label, hint) => `<label class="mode-pill" title="${escapeAttr(hint)}">
    <input type="radio" name="mode" value="${value}" ${state.mode === value ? 'checked' : ''} data-search-mode>
    <span>${escapeHtml(label)}</span>
  </label>`;

  const autocompleteAttrs = profile.autocomplete
    ? ` list="search-ac" hx-get="${escapeAttr(`${basePath}/autocomplete`)}" hx-trigger="input changed delay:250ms" hx-target="#search-ac" hx-swap="outerHTML" hx-sync="this:replace"`
    : '';

  return `<form method="get" action="${escapeAttr(basePath)}" class="stacked-form search-form" data-search-form
    hx-get="${escapeAttr(basePath)}" hx-target="#search-results" hx-swap="outerHTML"
    hx-push-url="true" hx-sync="this:drop" hx-indicator="#search-indicator">
    ${profile.hasText ? `<div class="search-main">
      <div class="mode-toggle" role="radiogroup" aria-label="Query mode">
        ${modePill('plain', 'Plain', 'Your text is matched literally - operators are escaped')}
        ${modePill('advanced', 'Advanced', 'Write MATCH operators yourself')}
      </div>
      <div class="search-box">
        <input type="search" name="q" value="${escapeAttr(state.q)}" placeholder="${profile.hasText ? 'Search this table&hellip;' : ''}"
          autocomplete="off" spellcheck="false" aria-label="Search query"${autocompleteAttrs}>
        ${profile.autocomplete ? renderAutocompleteDatalist([]) : ''}
        ${button({ label: 'Search', submit: true })}
        <span id="search-indicator" class="htmx-indicator muted"><span class="spinner"></span>Searching&hellip;</span>
      </div>
    </div>
    <p class="mode-hint mode-hint-plain muted">Plain mode matches your text literally &mdash; quotes, dashes and <code>@ | - " ~ / *</code> are searched as characters, not operators.</p>
    <div class="mode-hint mode-hint-advanced op-cheatsheet muted">
      <span class="cheat-title">MATCH operators:</span>
      ${operatorCheatsheet().map(([op, hint]) => `<span class="op-chip" title="${escapeAttr(hint)}"><code>${escapeHtml(op)}</code></span>`).join('')}
    </div>
    ${renderSearchOptions({ profile, state })}` : `<div class="search-main">
      <div class="search-box">
        ${button({ label: 'Apply filters', submit: true })}
        <span id="search-indicator" class="htmx-indicator muted"><span class="spinner"></span>Loading&hellip;</span>
      </div>
    </div>
    ${renderScanOptions({ profile, state })}`}
    ${renderFilterBlock({ basePath, profile, state })}
  </form>`;
}

function operatorCheatsheet() {
  return [
    ['a b', 'implicit AND - all words must match'],
    ['a | b', 'OR (binds tighter than AND)'],
    ['-word', 'NOT - exclude (needs at least one positive term)'],
    ['"a b"', 'exact phrase'],
    ['"a b"~4', 'proximity - words within 4 positions'],
    ['"a b c"/2', 'quorum - at least 2 of the words'],
    ['@title word', 'search one field'],
    ['@(t1,t2) word', 'search listed fields'],
    ['a NEAR/3 b', 'within 3 words, any order'],
    ['wild*', 'wildcard (needs min_infix_len / min_prefix_len)'],
    ['=word', 'exact form, no stemming (needs index_exact_words)'],
    ['word^2', 'boost term weight'],
    ['a MAYBE b', 'optional term that ranks matches higher'],
    ['( ... )', 'grouping']
  ];
}

function renderSearchOptions({ profile, state }) {
  const textFieldList = textFields(profile.fields);
  const facetable = filterableFields(profile.fields);
  const scoped = new Set(state.fields.length ? state.fields : textFieldList.map((item) => item.name));
  const hasCustom = state.fields.length > 0
    || state.ranker !== defaultRanker
    || Object.values(state.weights).some((value) => String(value ?? '').trim() !== '')
    || Boolean(state.facet)
    || state.fuzzy
    || state.perPage !== searchDefaultPerPage;

  return `<details class="search-options" ${hasCustom ? 'open' : ''}>
    <summary>Search options <small>fields, ranker, weights${profile.buddy ? ', fuzzy' : ''}, facet</small></summary>
    <div class="options-grid">
      <fieldset class="option-group" data-field-scope>
        <legend>Search in fields</legend>
        <div class="option-chips">
          ${textFieldList.map((item) => checkboxCard({
            name: 'field',
            value: item.name,
            label: item.name,
            checked: scoped.has(item.name),
            classes: 'checkbox-card compact-card'
          })).join('')}
        </div>
        <small class="muted">All checked (or none) = search every field.</small>
      </fieldset>
      <div class="option-group">
        ${field({
          label: 'Ranker',
          hint: 'OPTION ranker',
          control: selectInput({ name: 'ranker', value: state.ranker, options: searchRankers })
        })}
        ${facetable.length ? field({
          label: 'Facet by',
          hint: 'value counts become filters',
          control: selectInput({
            name: 'facet',
            value: state.facet,
            options: [{ value: '', label: 'No facet' }, ...facetable.map((item) => item.name)]
          })
        }) : ''}
        ${field({ label: 'Rows per page', control: selectInput({ name: 'perPage', value: state.perPage, options: [10, 25, 50, 100] }) })}
      </div>
      <fieldset class="option-group">
        <legend>Field weights <small>OPTION field_weights</small></legend>
        <div class="weight-grid">
          ${textFieldList.map((item) => field({
            label: item.name,
            control: textInput({
              name: `w_${item.name}`,
              value: state.weights[item.name] || '',
              type: 'number',
              attrs: { min: '0', step: '1', placeholder: '1' }
            })
          })).join('')}
        </div>
      </fieldset>
      ${profile.buddy ? `<fieldset class="option-group fuzzy-group">
        <legend>Fuzzy <small>typo-tolerant (Buddy)</small></legend>
        <div class="option-chips">
          ${checkboxCard({ name: 'fuzzy', label: 'fuzzy=1', checked: state.fuzzy, classes: 'checkbox-card compact-card', attrs: { 'data-fuzzy-toggle': true } })}
          ${checkboxCard({ name: 'preserve', label: 'preserve exact', checked: state.preserve, classes: 'checkbox-card compact-card' })}
        </div>
        <div class="fuzzy-fields">
          ${field({
            label: 'Distance',
            control: selectInput({
              name: 'distance',
              value: String(state.distance ?? ''),
              options: [{ value: '', label: 'Default (2)' }, '1', '2', '3', '4']
            })
          })}
          ${field({
            label: 'Keyboard layouts',
            hint: "e.g. us,ru",
            control: textInput({ name: 'layouts', value: state.layouts, attrs: { placeholder: 'us,ru', pattern: '[A-Za-z]{2}(,[A-Za-z]{2})*' } })
          })}
        </div>
        <small class="muted">Fuzzy takes plain words (an optional "phrase") only &mdash; advanced operators and field scoping are unavailable while it is on.</small>
      </fieldset>` : ''}
    </div>
  </details>`;
}

function renderScanOptions({ profile, state }) {
  const facetable = filterableFields(profile.fields);
  return `<div class="options-grid scan-options">
    ${facetable.length ? field({
      label: 'Facet by',
      hint: 'value counts become filters',
      control: selectInput({
        name: 'facet',
        value: state.facet,
        options: [{ value: '', label: 'No facet' }, ...facetable.map((item) => item.name)]
      })
    }) : ''}
    ${field({ label: 'Rows per page', control: selectInput({ name: 'perPage', value: state.perPage, options: [10, 25, 50, 100] }) })}
  </div>`;
}

// --- filters (chips + builder) ----------------------------------------------

// Lives inside the form so chips submit as hidden `f` inputs; every results
// fragment re-sends it as an out-of-band swap, keeping the chips in sync with
// the URL after adds, removals and facet clicks.
export function renderFilterBlock({ basePath, profile, state, oob = false }) {
  const filterable = filterableFields(profile.fields);
  if (!filterable.length) {
    return `<div id="filter-block" class="filter-block"${oob ? ' hx-swap-oob="outerHTML"' : ''}></div>`;
  }

  const chips = state.filters.map((filter, index) => {
    const remaining = state.filters.filter((_, i) => i !== index);
    const href = searchUrl(basePath, state, { filters: remaining, page: 1 });
    return `<span class="filter-chip">
      <input type="hidden" name="f" value="${escapeAttr(`${filter.attr}|${filter.op}|${filter.value}`)}">
      <code>${escapeHtml(filter.attr)} ${escapeHtml(filter.op)} ${escapeHtml(truncateText(filter.value, 30))}</code>
      <a class="chip-remove" href="${escapeAttr(href)}"${resultsLinkAttrs(href)} aria-label="Remove filter" title="Remove filter">&times;</a>
    </span>`;
  }).join('');

  return `<div id="filter-block" class="filter-block"${oob ? ' hx-swap-oob="outerHTML"' : ''}>
    <div class="filter-chips">
      <span class="filter-label muted">Attribute filters</span>
      ${chips || '<span class="muted">none</span>'}
    </div>
    <div class="add-filter">
      ${selectInput({
        name: 'nf_attr',
        value: '',
        options: [{ value: '', label: 'Add filter&hellip;' }, ...filterable.map((item) => ({ value: item.name, label: `${item.name} (${item.type})` }))],
        attrs: { 'aria-label': 'Filter attribute' }
      })}
      ${selectInput({ name: 'nf_op', value: '=', options: ['=', '!=', '<', '<=', '>', '>='], attrs: { 'aria-label': 'Filter operator' } })}
      ${textInput({ name: 'nf_value', attrs: { placeholder: 'value', 'aria-label': 'Filter value' } })}
      ${button({ label: 'Add', submit: true, variant: 'secondary' })}
    </div>
  </div>`;
}

function truncateText(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// --- autocomplete ------------------------------------------------------------

export function renderAutocompleteDatalist(suggestions = []) {
  return `<datalist id="search-ac">${suggestions.slice(0, 8).map((item) => (
    `<option value="${escapeAttr(item)}"></option>`
  )).join('')}</datalist>`;
}

// --- results -----------------------------------------------------------------

// The #search-results swap target: insight, facets, hits and pagination in one
// block. `results` is null until the route has run the query (it always runs);
// `results.error` renders instead of the list when the request failed.
export function renderSearchResults({ connection, table, profile, state, results }) {
  const basePath = searchBasePath(connection, table);
  if (!results) return '<div id="search-results" class="search-results"></div>';

  if (results.error) {
    return `<div id="search-results" class="search-results">
      <section class="panel">${renderAlert(results.error)}</section>
    </div>`;
  }

  const rows = results.hits?.data || [];
  return `<div id="search-results" class="search-results">
    ${renderMessages(results.messages || [])}
    ${results.insight ? renderInsight({ basePath, state, insight: results.insight }) : ''}
    ${results.didYouMean ? renderDidYouMean({ basePath, state, didYouMean: results.didYouMean }) : ''}
    ${results.facet ? renderFacetPanel({ basePath, state, facet: results.facet }) : ''}
    <section class="panel results-panel">
      <header class="result-heading">
        <h2>${state.q || state.filters.length ? 'Results' : 'All rows'}</h2>
        <span class="muted">${escapeHtml(resultsRangeLabel(results.total, state.page, state.perPage, rows.length))}</span>
      </header>
      ${rows.length ? renderHitList({ connection, table, profile, state, rows }) : renderNoResults({ profile, state })}
      ${renderSearchPagination({ basePath, state, total: results.total })}
    </section>
  </div>`;
}

export function renderSearchReproducePanel({ connection, results, oob = false }) {
  const attrs = `id="search-reproduce-panel" class="panel reproduce-panel"${oob ? ' hx-swap-oob="outerHTML"' : ''}`;
  const reproduce = results?.reproduce;
  if (!reproduce) {
    return `<section ${attrs}>
      <details class="reproduce-details">
        <summary>Developer / reproduce this query <small class="muted">no request sent</small></summary>
        <p class="muted">No Manticore search request was sent for the current state.</p>
      </details>
    </section>`;
  }

  const sqlId = 'search-reproduce-sql';
  const curlId = 'search-reproduce-curl';
  const countId = 'search-reproduce-count';
  const consoleHref = `/connections/${connection.id}/console?sql=${encodeURIComponent(reproduce.sql)}`;
  const meta = [
    ['Method', reproduce.method],
    ['Path', reproduce.path],
    ['Content-Type', reproduce.contentType]
  ];

  return `<section ${attrs}>
    <details class="reproduce-details">
      <summary>Developer / reproduce this query
        <small class="muted">${escapeHtml(reproduce.method)} ${escapeHtml(reproduce.path)}</small>
      </summary>
      <div class="reproduce-body">
        <dl class="request-meta">
          ${meta.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd><code>${escapeHtml(value)}</code></dd></div>`).join('')}
        </dl>
        ${reproduce.authNote ? renderAlert(reproduce.authNote, 'warning') : ''}
        ${renderReproduceNotes(reproduce)}
        <div class="reproduce-actions">
          ${button({ label: 'Copy SQL', variant: 'secondary compact-copy', attrs: { 'data-copy-source': sqlId } })}
          ${button({ label: 'Open in SQL console', href: consoleHref, variant: 'secondary' })}
        </div>
        ${renderReproduceBlock({
          id: sqlId,
          title: reproduce.label || 'Search request',
          subtitle: 'SQL console body',
          value: reproduce.sql
        })}
        ${reproduce.countSql ? `<details class="reproduce-count">
          <summary>Pagination count SQL <small class="muted">used for total rows</small></summary>
          ${renderReproduceBlock({
            id: countId,
            title: 'Count request',
            subtitle: 'SQL body',
            value: reproduce.countSql
          })}
        </details>` : ''}
        ${renderReproduceBlock({
          id: curlId,
          title: 'curl',
          subtitle: reproduce.url,
          value: reproduce.curl,
          copyLabel: 'Copy curl'
        })}
      </div>
    </details>
  </section>`;
}

function renderReproduceNotes(reproduce) {
  const sql = `${reproduce?.sql || ''}\n${reproduce?.countSql || ''}`;
  if (!sql.includes(highlightBefore) && !sql.includes(highlightAfter)) return '';
  return renderAlert(
    'U+E000 and U+E001 in HIGHLIGHT() are internal before/after_match markers. MantiFox copies them exactly, escapes result text, then renders only those markers as <mark> highlights.',
    'warning'
  );
}

function renderReproduceBlock({ id, title, subtitle = '', value, copyLabel = 'Copy' }) {
  return `<div class="reproduce-block">
    <header class="result-heading">
      <div>
        <h3>${escapeHtml(title)}</h3>
        ${subtitle ? `<small class="muted">${escapeHtml(subtitle)}</small>` : ''}
      </div>
      ${button({ label: copyLabel, variant: 'secondary compact-copy', attrs: { 'data-copy-source': id } })}
    </header>
    <pre id="${escapeAttr(id)}" class="reproduce-code"><code>${escapeHtml(value)}</code></pre>
  </div>`;
}

function resultsRangeLabel(total, page, perPage, count) {
  if (!count) return `0 of ${total}`;
  const offset = (page - 1) * perPage;
  return `${offset + 1}-${offset + count} of ${total}`;
}

function renderNoResults({ profile, state }) {
  if (!state.q && !state.filters.length) return emptyState('The table is empty.');
  const hints = [];
  if (state.q && profile.hasText) {
    hints.push(state.mode === 'advanced' ? 'check the operator syntax' : 'try fewer or shorter words');
    if (profile.buddy && !state.fuzzy) hints.push('or enable fuzzy to catch typos');
  }
  if (state.filters.length) hints.push('or remove a filter');
  return emptyState(`No matches${hints.length ? ` — ${hints.join(', ')}` : ''}.`);
}

// --- insight -----------------------------------------------------------------

function renderInsight({ basePath, state, insight }) {
  const cells = [
    ['total_found', insight.totalFound],
    ['returned', insight.total],
    ['time', insight.time ? `${insight.time}s` : `${insight.elapsedMs}ms`]
  ];
  const keywordRows = (insight.keywords || []).slice(0, 24);
  const explainUrl = `${basePath}/explain?${searchStateParams(state, { page: 1 }).toString()}`;

  return `<section class="panel insight-panel">
    <details class="insight-details">
      <summary>Query insight
        <span class="insight-summary muted">${cells.map(([label, value]) => `${escapeHtml(label)}: <b>${escapeHtml(valueToText(value))}</b>`).join(' &middot; ')}
        ${insight.source === 'keywords' ? ' &middot; via CALL KEYWORDS' : ''}</span>
      </summary>
      <div class="insight-body">
        ${keywordRows.length ? `<table class="insight-table">
          <thead><tr><th>keyword</th><th>docs</th><th>hits</th></tr></thead>
          <tbody>${keywordRows.map((row) => `<tr>
            <td><code>${escapeHtml(row.keyword)}</code></td>
            <td>${escapeHtml(row.docs)}</td>
            <td>${escapeHtml(row.hits)}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<p class="muted">No per-keyword stats for this query.</p>'}
        <details class="explain-block" data-explain-url="${escapeAttr(explainUrl)}">
          <summary>Explain query <small>how Manticore parsed it</small></summary>
          <div class="explain-body"><span class="muted">Loading&hellip;</span></div>
        </details>
        <p class="muted score-note">Scores from weight() are comparable only within one query &mdash; never across queries.</p>
      </div>
    </details>
  </section>`;
}

export function renderExplainBody({ tree = '', error = '' }) {
  if (error) return renderAlert(error);
  if (!tree) return '<p class="muted">No query tree returned.</p>';
  return `<pre class="explain-tree">${escapeHtml(tree)}</pre>`;
}

// --- did you mean --------------------------------------------------------------

function renderDidYouMean({ basePath, state, didYouMean }) {
  const href = searchUrl(basePath, state, { q: didYouMean.query, page: 1 });
  return `<p class="did-you-mean">Did you mean
    <a href="${escapeAttr(href)}"${resultsLinkAttrs(href)}><b>${escapeHtml(didYouMean.query)}</b></a>?
    <small class="muted">(${escapeHtml(didYouMean.docs)} docs for &laquo;${escapeHtml(didYouMean.suggest)}&raquo;)</small>
  </p>`;
}

// --- facets ----------------------------------------------------------------------

function renderFacetPanel({ basePath, state, facet }) {
  const active = new Set(state.filters
    .filter((filter) => filter.attr === facet.attr && filter.op === '=')
    .map((filter) => filter.value));

  const chips = facet.values.map((entry) => {
    const isActive = active.has(entry.value);
    const nextFilters = isActive
      ? state.filters.filter((filter) => !(filter.attr === facet.attr && filter.op === '=' && filter.value === entry.value))
      : [...state.filters, { attr: facet.attr, op: '=', value: entry.value }];
    const href = searchUrl(basePath, state, { filters: nextFilters, page: 1 });
    return `<a class="facet-chip${isActive ? ' active' : ''}" href="${escapeAttr(href)}"${resultsLinkAttrs(href)}
      title="${escapeAttr(isActive ? 'Remove this filter' : `Filter: ${facet.attr} = ${entry.value}`)}">
      <span class="facet-value">${escapeHtml(truncateText(entry.value === '' ? '(empty)' : entry.value, 40))}</span>
      <span class="facet-count">${escapeHtml(entry.count)}</span>
    </a>`;
  }).join('');

  return `<section class="panel facet-panel">
    <header class="result-heading">
      <h2>Facet: <code>${escapeHtml(facet.attr)}</code></h2>
      <span class="muted">${facet.values.length >= searchFacetLimit ? `top ${searchFacetLimit} values · ` : ''}click to filter</span>
    </header>
    <div class="facet-chips">${chips || '<span class="muted">No values.</span>'}</div>
  </section>`;
}

// --- hit list -----------------------------------------------------------------

function renderHighlighted(value) {
  let text = escapeHtml(valueToText(value));
  const opens = text.split(highlightBefore).length - 1;
  const closes = text.split(highlightAfter).length - 1;
  text = text.replaceAll(highlightBefore, '<mark>').replaceAll(highlightAfter, '</mark>');
  // A snippet cut mid-highlight would leak an unclosed <mark>; balance it.
  return opens > closes ? `${text}</mark>` : text;
}

function renderHitList({ connection, table, profile, state, rows }) {
  const tablePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  const stored = storedTextFields(profile.fields).map((item) => item.name);
  const unreadable = state.q
    ? textFields(profile.fields).filter((item) => !stored.includes(item.name)).map((item) => item.name)
    : [];
  const attrFields = profile.fields.filter((item) => item.name !== 'id' && !isTextField(item));

  return `${unreadable.length ? `<p class="muted unreadable-note">${escapeHtml(unreadable.join(', '))}: indexed but not stored — matched content cannot be displayed or highlighted.</p>` : ''}
  <div class="result-list">
    ${rows.map((row) => renderHit({ tablePath, profile, state, row, stored, attrFields })).join('')}
  </div>`;
}

function renderHit({ tablePath, profile, state, row, stored, attrFields }) {
  const rowId = valueToText(row.id);
  const detailId = `row-detail-${rowId}`;
  const viewUrl = `${tablePath}/rows/${encodeURIComponent(rowId)}/view`;
  const hasMatch = Boolean(state.q);

  const snippets = hasMatch
    ? stored.map((name) => {
      const highlighted = row[`_mfx_hl_${name}`];
      const source = highlighted === undefined || highlighted === null || highlighted === ''
        ? truncateText(valueToText(row[name]), 220)
        : highlighted;
      if (source === '' || source === undefined) return '';
      return `<p class="snippet"><span class="snippet-field">${escapeHtml(name)}</span>${renderHighlighted(source)}</p>`;
    }).filter(Boolean).join('')
    : stored.map((name) => {
      const text = valueToText(row[name]);
      return text ? `<p class="snippet"><span class="snippet-field">${escapeHtml(name)}</span>${escapeHtml(truncateText(text, 220))}</p>` : '';
    }).filter(Boolean).join('');

  const attrs = attrFields.map((item) => {
    const text = truncateText(valueToText(row[item.name]), 40);
    return `<span class="attr-pair"><span class="attr-name">${escapeHtml(item.name)}</span> ${escapeHtml(text === '' ? '—' : text)}</span>`;
  }).join('');

  return `<article class="result-card">
    <header class="result-card-head">
      <button type="button" class="link-button result-open" hx-get="${escapeAttr(viewUrl)}" hx-target="#${escapeAttr(detailId)}" hx-swap="innerHTML" title="View the full record">
        id ${escapeHtml(rowId)}
      </button>
      ${hasMatch && row._mfx_score !== undefined ? `<span class="score-chip" title="weight() — comparable only within this query">score ${escapeHtml(valueToText(row._mfx_score))}</span>` : ''}
      <span class="result-actions">
        ${profile.canWrite ? `${button({ label: 'Edit', href: `${tablePath}/rows/${encodeURIComponent(rowId)}/edit`, variant: 'secondary' })}
        ${button({ label: 'Delete', href: `${tablePath}/rows/${encodeURIComponent(rowId)}/delete`, variant: 'secondary danger-link' })}` : ''}
      </span>
    </header>
    ${snippets ? `<div class="result-snippets">${snippets}</div>` : ''}
    ${attrs ? `<p class="result-attrs">${attrs}</p>` : ''}
    <div class="row-detail" id="${escapeAttr(detailId)}"></div>
  </article>`;
}

// --- pagination -----------------------------------------------------------------

function renderSearchPagination({ basePath, state, total }) {
  // Same cap as the route (§4.2): pages past the browse window are never
  // reachable, so Next must not point at them.
  const maxPage = Math.max(1, Math.min(
    Math.ceil(total / state.perPage),
    Math.floor(maxBrowseWindow / state.perPage)
  ));
  if (maxPage <= 1) return '';
  const link = (targetPage, label, isEdge) => {
    const href = searchUrl(basePath, state, { page: targetPage });
    return `<a class="button secondary ${isEdge ? 'disabled' : ''}" href="${escapeAttr(href)}"${resultsLinkAttrs(href)}>${escapeHtml(label)}</a>`;
  };
  return `<nav class="pagination">
    ${link(Math.max(1, state.page - 1), 'Previous', state.page === 1)}
    <span>Page ${escapeHtml(state.page)} of ${escapeHtml(maxPage)}</span>
    ${link(Math.min(maxPage, state.page + 1), 'Next', state.page === maxPage)}
  </nav>`;
}

// --- row detail (full record, reused by search hits) ---------------------------

export function renderRowDetail({ connection, table, fields, row, canWrite, asFragment }) {
  const tablePath = `/connections/${connection.id}/tables/${encodeURIComponent(table)}`;
  const rowId = valueToText(row?.id ?? '');
  const known = new Set((fields || []).map((item) => item.name));
  const extras = Object.keys(row || {}).filter((key) => !known.has(key) && !key.startsWith('_mfx_'));

  // A schema field missing from the row was omitted by SELECT * because it
  // cannot be read back (indexed-only text) — say so instead of rendering the
  // same dash an empty value gets.
  const pairs = [
    ...(fields || []).map((item) => [
      item.name,
      row?.[item.name],
      `${item.type}${item.properties ? `, ${item.properties}` : ''}`,
      !Object.prototype.hasOwnProperty.call(row || {}, item.name)
    ]),
    ...extras.map((key) => [key, row?.[key], '', false])
  ];

  const body = `<div class="row-detail-card">
    <header class="result-heading">
      <h3>Row ${escapeHtml(rowId)}</h3>
      <span class="result-actions">
        ${canWrite ? `${button({ label: 'Edit', href: `${tablePath}/rows/${encodeURIComponent(rowId)}/edit`, variant: 'secondary' })}
        ${button({ label: 'Delete', href: `${tablePath}/rows/${encodeURIComponent(rowId)}/delete`, variant: 'secondary danger-link' })}` : ''}
        ${asFragment ? `<button type="button" class="secondary" data-detail-close>Close</button>` : ''}
      </span>
    </header>
    <dl class="status-grid row-detail-grid">
      ${pairs.map(([name, value, hint, unreadable]) => `<div>
        <dt><code>${escapeHtml(name)}</code>${hint ? ` <small class="muted">${escapeHtml(hint)}</small>` : ''}</dt>
        <dd>${unreadable
          ? '<span class="muted">not stored — value unreadable</span>'
          : `<code>${escapeHtml(valueToText(value) === '' ? '—' : valueToText(value))}</code>`}</dd>
      </div>`).join('')}
    </dl>
  </div>`;

  if (asFragment) return body;
  return {
    title: `Row ${rowId} - ${table}`,
    body: `<section class="panel">
      <p><a href="${escapeAttr(tablePath)}">Back to ${escapeHtml(table)}</a></p>
      ${body}
    </section>`
  };
}

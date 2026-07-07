import { escapeHtml } from '../html.js';
import { renderToastRegion, renderToastsOob } from './components.js';

export function fullTitle(title) {
  return title ? `${title} - MantiFox` : 'MantiFox';
}

// hx-boost on #main turns every plain link/form inside it into an AJAX swap of
// #main (links push their URL). Controls that need a narrower swap (pagination,
// search, the console) declare their own hx-* attributes and win over boost.
// hx-sync serializes in-flight navigation (a new click aborts the previous
// request); forms override it with this:drop to block double submits.
const mainHxAttrs = [
  'tabindex="-1"',
  'hx-boost="true"',
  'hx-target="#main"',
  'hx-swap="innerHTML show:window:top"',
  'hx-sync="this:replace"',
  'hx-disabled-elt="find button[type=\'submit\']"'
].join(' ');

function navLinkAttrs(href) {
  return ` hx-get="${href}" hx-target="#main" hx-swap="innerHTML show:window:top" hx-sync="#main:replace" hx-push-url="true"`;
}

export function layout({ title, body, authenticated = true }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101218">
  <meta name="htmx-config" content='{"scrollIntoViewOnBoost":false}'>
  <title>${escapeHtml(fullTitle(title))}</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='8'%20fill='%234cc9ad'/%3E%3Cpath%20d='M7%2024V9l9%208%209-8v15'%20fill='none'%20stroke='%2306231d'%20stroke-width='3'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/styles.css">
  <script defer src="/htmx.min.js"></script>
  <script defer src="/app.js"></script>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/"${authenticated ? navLinkAttrs('/') : ''}>MantiFox</a>
    ${authenticated ? `<nav class="nav">
      <a href="/"${navLinkAttrs('/')}>Connections</a>
      <form method="post" action="/logout" class="inline-form">
        <button type="submit" class="link-button">Log out</button>
      </form>
    </nav>` : ''}
  </header>
  <main id="main" class="container"${authenticated ? ` ${mainHxAttrs}` : ''}>
    ${body}
  </main>
  ${renderToastRegion()}
</body>
</html>`;
}

// Fragment response for htmx requests: the same content the layout would put
// inside #main, plus a <title> so htmx keeps document.title in sync, plus any
// out-of-band toasts (they must sit at the top level of the fragment).
export function fragment({ title, body, toasts = [] }) {
  return `<title>${escapeHtml(fullTitle(title))}</title>${renderToastsOob(toasts)}${body}`;
}

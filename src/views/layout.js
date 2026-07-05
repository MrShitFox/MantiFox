import { escapeHtml } from '../html.js';

export function layout({ title, body, authenticated = true }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101218">
  <title>${escapeHtml(title ? `${title} - MantiFox` : 'MantiFox')}</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='8'%20fill='%234cc9ad'/%3E%3Cpath%20d='M7%2024V9l9%208%209-8v15'%20fill='none'%20stroke='%2306231d'%20stroke-width='3'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/styles.css">
  <script defer src="/app.js"></script>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">MantiFox</a>
    ${authenticated ? `<nav class="nav">
      <a href="/">Connections</a>
      <form method="post" action="/logout" class="inline-form">
        <button type="submit" class="link-button">Log out</button>
      </form>
    </nav>` : ''}
  </header>
  <main class="container">
    ${body}
  </main>
</body>
</html>`;
}

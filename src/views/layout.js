import { escapeHtml } from '../html.js';

export function layout({ title, body, authenticated = true }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title ? `${title} - MantiFox` : 'MantiFox')}</title>
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

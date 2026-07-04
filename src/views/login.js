import { layout } from './layout.js';
import { renderAlert } from './components.js';

export function renderLoginPage({ error = '' } = {}) {
  return layout({
    title: 'Login',
    authenticated: false,
    body: `<section class="panel login-panel">
      <h1>Log in</h1>
      <p>Use the admin password from <code>ADMIN_PASSWORD</code>.</p>
      ${renderAlert(error)}
      <form method="post" action="/login" class="stacked-form">
        <label>
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" autofocus required>
        </label>
        <button type="submit">Log in</button>
      </form>
    </section>`
  });
}

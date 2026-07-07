import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestSession } from './auth.js';
import { config } from './config.js';
import './db.js';
import { handleApi } from './routes/api.js';
import { handleLogin, handlePages } from './routes/pages.js';
import { isHtmx, redirect, send, sendJson } from './router.js';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon']
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  try {
    if (isStaticPath(url.pathname)) {
      return serveStatic(res, url.pathname);
    }

    if (url.pathname === '/login') {
      return handleLogin(req, res, url);
    }

    const session = getRequestSession(req);
    if (!session) {
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 401, { error: 'Authentication required' });
      }
      // An expired session mid-htmx-request must not swap the login page into
      // a panel fragment; HX-Redirect makes htmx do a full browser navigation.
      if (isHtmx(req)) {
        return send(res, 401, {
          'Content-Type': 'text/plain; charset=utf-8',
          'HX-Redirect': '/login'
        }, 'Authentication required');
      }
      return redirect(res, '/login');
    }

    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
    }

    return handlePages(req, res, url, session);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, statusCode, { error: error.message || 'Internal server error' });
    }
    return send(res, statusCode, { 'Content-Type': 'text/plain; charset=utf-8' }, error.message || 'Internal server error');
  }
});

server.listen(config.port, () => {
  process.stdout.write(`MantiFox listening on http://localhost:${config.port}\n`);
});

function isStaticPath(pathname) {
  return pathname === '/app.js' || pathname === '/styles.css' || pathname === '/htmx.min.js' || pathname.startsWith('/public/');
}

async function serveStatic(res, pathname) {
  const relative = pathname.startsWith('/public/') ? pathname.slice('/public/'.length) : pathname.slice(1);
  const normalized = path.normalize(relative).replace(/^\.\.(?:\/|$)/, '');
  const filePath = path.join(publicRoot, normalized);

  if (!filePath.startsWith(publicRoot)) {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  }

  try {
    const body = await fs.readFile(filePath);
    const contentType = contentTypes.get(path.extname(filePath)) || 'application/octet-stream';
    return send(res, 200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' }, body);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    }
    throw error;
  }
}

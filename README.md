# MantiFox

Self-hosted web admin GUI for Manticore Search: saved HTTP connections, table browsing, schema view, paginated/searchable data grids, row forms, and an SQL console.

## Requirements

- Node.js 20 or newer.
- Manticore Search HTTP API endpoint, for example `http://192.168.1.75:9318`.
- No build step. Runtime dependency: `better-sqlite3` only.

## Install

```bash
npm install
```

## Run

```bash
ADMIN_PASSWORD='change-me' SESSION_SECRET='long-random-secret' npm start
```

Development mode with Node's watcher:

```bash
ADMIN_PASSWORD='change-me' SESSION_SECRET='long-random-secret' npm run dev
```

Environment variables:

- `PORT`, default `3000`.
- `ADMIN_PASSWORD`, required. This is the login password.
- `SESSION_SECRET`, required. Used to sign session cookies.
- `APP_DB_PATH`, default `./data/app.sqlite`.

## Usage

1. Open `http://localhost:3000`.
2. Log in with `ADMIN_PASSWORD`.
3. Add a connection with explicit scheme, host and HTTP port, for example `http`, `192.168.1.75`, `9318`.
4. Use `Browse` to list tables, inspect schema/status, search rows with `MATCH`, and insert/edit/delete rows.
5. Use `SQL` to run arbitrary SQL through Manticore `POST /sql?mode=raw`.

## Security Notes

- Every page and API route except `/login` and static assets requires a signed session cookie.
- Session ids are stored in SQLite and cookies are `HttpOnly`, `SameSite=Strict`, `Path=/`; `Secure` is added when the request is HTTPS.
- Saved Manticore credentials are stored in `APP_DB_PATH`. Protect the `data/` directory on disk.
- The SQL console intentionally allows arbitrary SQL for the authenticated admin.

## Manticore API

MantiFox uses only Manticore HTTP APIs via Node's global `fetch`. The primary endpoint is `POST /sql?mode=raw` with raw SQL in the body. It does not use the MySQL port, `/cli`, or `/cli_json`.

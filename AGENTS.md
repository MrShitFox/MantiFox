# AGENTS.md

Guidance for AI coding agents (OpenCode, etc.) working in this repository.
Read this file fully before writing any code. It is the source of truth for
scope, stack, and conventions.

---

## 1. What we are building

A self-hosted **web admin GUI for Manticore Search** — conceptually
"phpMyAdmin for Manticore". A single small service you install on a server; the
admin opens it in a browser and can:

- Register/save multiple Manticore server connections (arbitrary host + port).
- Browse tables: list tables, view schema (`DESC`), see row counts.
- Create and drop tables through a GUI form (not only via the SQL console);
  optionally add/drop columns and truncate.
- Read data with pagination, sorting, and full-text search, shown in HTML tables.
- Insert / edit / delete individual rows through convenient forms.
- Run arbitrary SQL in a console (like the phpMyAdmin SQL tab).

Target user: a single administrator (optionally a few). Internal tool, not a
public multi-tenant SaaS.

---

## 2. Prime directive: radical simplicity, minimal dependencies

The owner explicitly values simplicity and prefers writing small things by hand
over pulling a library. Respect this hard.

**DO:**
- Use Node's built-ins for everything they cover (`node:http`, `node:crypto`,
  global `fetch`, `node:fs`, `node:url`).
- Talk to Manticore over its **HTTP JSON API** using global `fetch` only.
- Keep the whole app with **zero build step** (plain JavaScript, ESM).

**DO NOT (unless explicitly asked):**
- Do NOT add a MySQL/MariaDB driver (`mysql2`, `mysql`, etc.). Manticore's HTTP
  API replaces it entirely. The MySQL/SQL port is intentionally NOT used.
- Do NOT add a backend web framework (Express/Fastify/Koa/NestJS). Use native
  `node:http`. (Express is the *only* one that may be considered if routing
  becomes genuinely unwieldy — ask first.)
- Do NOT add a frontend SPA framework (React/Vue/Svelte/Angular) or any bundler
  (webpack/vite/esbuild/rollup). Use server-rendered HTML + one vanilla JS file.
- Do NOT add an ORM (Prisma/Drizzle/TypeORM/Knex). Use `better-sqlite3` raw SQL.
- Do NOT add an auth/session library (passport, express-session, jsonwebtoken).
  Use `node:crypto` + a signed cookie.
- Do NOT add a password-hashing library (bcrypt, argon2). Use `node:crypto`
  `scrypt`, which is built in.
- Do NOT add a CSS framework build (Tailwind/PostCSS). Plain CSS is fine; a
  single classless CSS file (e.g. Pico.css via one `<link>`) is acceptable.
- Do NOT introduce TypeScript + a compiler/transpiler. Ship plain JS. (If types
  are wanted, use JSDoc comments — no build step.)

If you think a dependency is truly warranted, stop and explain the tradeoff
instead of adding it silently.

---

## 3. Tech stack

- **Runtime:** Node.js LTS, **>= 20** (recommend >= 22). Global `fetch` is
  built in (no `node-fetch`). `--watch` is built in for dev.
- **Language:** plain JavaScript, **ESM** (`"type": "module"` in package.json).
  No build/transpile step. Files use `import`/`export`.
- **HTTP server:** native `node:http` (`http.createServer`).
- **Manticore access:** global `fetch` → Manticore HTTP API (see section 4).
- **App database** (saved connections, sessions): **`better-sqlite3`** (npm).
  Synchronous API, single file, prebuilt binaries so `npm install` needs no
  compiler on common platforms. This is the ONLY runtime dependency.
  - Alternative (zero-dep): Node's built-in `node:sqlite`. It is experimental
    and requires Node >= 22.5 (a flag on some versions). Prefer `better-sqlite3`
    for portability unless the owner asks otherwise.
- **Auth:** `node:crypto` — `scryptSync` for password hashing, `randomBytes` for
  salts/session ids, `createHmac` for signing the session cookie,
  `timingSafeEqual` for comparisons.
- **Frontend:** server-rendered HTML built with template literals + one vanilla
  `public/app.js`. No framework, no bundler. Plain CSS in `public/styles.css`
  (optionally one classless CSS file via `<link>`).

---

## 4. Manticore HTTP API — reference (VERIFIED against the current manual)

Verified against https://manual.manticoresearch.com/Connecting_to_the_server/HTTP
(and the Data creation/modification pages). Read carefully — this is the part
agents most often get wrong.

### Ports (defaults — but this tool must accept ANY host + port per connection)

- `9306` — MySQL protocol (SQL). **This tool does NOT use it.**
- `9308` — HTTP / HTTPS. **This is the default the tool talks to.**
- `9312` — HTTP / HTTPS + Manticore binary protocol.

Note: ports are fully configurable in Manticore's config, so never hardcode
9308. The saved connection stores host + port; the dev/test node below uses a
non-default HTTP port on purpose.

### 4.1 SQL over HTTP — the primary interface for this tool

**`POST /sql?mode=raw` — THE main endpoint. Use it for almost everything.**

- Accepts: **any valid SQL**, including multi-queries separated by `;`
  (SELECT, SHOW, DESC/DESCRIBE, CREATE, ALTER, INSERT, REPLACE, UPDATE, DELETE,
  TRUNCATE, etc.).
- Request body (POST): either
  - raw plain-text SQL as the body — do **NOT** URL-encode it; or
  - `mode=raw&query=<URL-ENCODED-SQL>` as a urlencoded body; or
  - GET `/sql?mode=raw&query=<URL-ENCODED-SQL>`.
  Prefer sending the SQL as the raw request body with `?mode=raw` in the URL —
  simplest and no encoding pitfalls.
- Response: **a JSON array** of one result set per statement. Each result set:

  ```json
  [
    {
      "columns": [
        { "Field": { "type": "string" } },
        { "Type":  { "type": "string" } },
        { "Properties": { "type": "string" } }
      ],
      "data": [
        { "Field": "id",    "Type": "bigint", "Properties": "" },
        { "Field": "title", "Type": "text",   "Properties": "indexed" }
      ],
      "total": 2,
      "error": "",
      "warning": ""
    }
  ]
  ```

  - `columns` = ordered column descriptors; the key is the column name.
  - `data` = array of row objects keyed by column name.
  - `total` = row count for that result set.
  - `error` / `warning` = per-result-set strings; **always check them** and
    surface non-empty values to the user verbatim.
- Use for: the SQL console, schema introspection, browsing, row counts — this
  single endpoint can drive the entire app. For rendering a generic data grid,
  read `columns` for headers and `data` for rows.

**`POST /sql` (without `mode=raw`) — SELECT only, search-shaped JSON.**

- Accepts: a single `SELECT` (no other statements, no multi-query).
- Response:

  ```json
  {
    "took": 0,
    "timed_out": false,
    "hits": {
      "total": 2,
      "total_relation": "eq",
      "hits": [
        { "_id": 2, "_score": 2356, "_source": { "subject": "php manticore", "author_id": 12 } },
        { "_id": 1, "_score": 2356, "_source": { "subject": "php manticore", "author_id": 11 } }
      ]
    }
  }
  ```

  Map `hits.hits[]._id` + `_source` into rows.
- Optional: use this for the data browser if you prefer the hits shape. Not
  required — `/sql?mode=raw` already covers it.

**`/cli` and `/cli_json` — DO NOT USE in this tool.**

The manual explicitly states these are for manual interaction (curl/browser)
and **"not intended for use in automated scripts. Use the /sql endpoint
instead."** `/cli` also requires the Manticore Buddy component. We rely on
`/sql?mode=raw` instead. (Listed here only so the agent knows to avoid them.)

### 4.2 Introspection queries (run via `/sql?mode=raw`)

- `SHOW TABLES` — list tables (rows: table name + type).
- `DESC <table>` / `DESCRIBE <table>` — columns: `Field`, `Type`, `Properties`.
- `SHOW TABLE <table> STATUS` — stats incl. row count / disk size.
- `SELECT COUNT(*) FROM <table>` — row count.
- `SHOW VERSION` — server version (nice for the connection "test" button).
- Smoke/health check for a saved connection: `POST /sql?mode=raw` body
  `SELECT 1` (or `SHOW TABLES`); a 200 with no `error` means the node is up.

### 4.3 JSON data endpoints (OPTIONAL — for structured row CRUD)

Prefer building INSERT/UPDATE/DELETE as SQL through `/sql?mode=raw`. These JSON
endpoints are an alternative if you want structured, id-based operations. Modern
short paths shown; the older `/json/<name>` paths still work as aliases.

Manticore-native request format (note: `doc` is required; `table` is the modern
key, `index` is accepted as a legacy alias):

- `POST /insert`
  `{ "table": "products", "id": 1, "doc": { "title": "bag", "price": 9.9 } }`
  RT (real-time) tables only. `id` may be omitted or `0` for auto-id.
- `POST /replace` (alias `/index`) — same shape; upserts by `id`.
- `POST /update` — by id `{ "table":"products", "id":1, "doc":{ "price":10 } }`,
  or update-by-query `{ "table":"products", "doc":{...}, "query":{ ... } }`.
- `POST /delete` — by id `{ "table":"products", "id":1 }`, or delete-by-query
  `{ "table":"products", "query": { "match": { "*": "apple" } } }`.
- `POST /bulk` — batch ops. Body is **NDJSON**, header
  `Content-Type: application/x-ndjson`. One JSON action per line ending in `\n`:
  ```
  { "insert": { "table": "products", "id": 1, "doc": { "title": "one" } } }
  { "update": { "table": "products", "id": 2, "doc": { "price": 20 } } }
  { "delete": { "table": "products", "id": 3 } }
  ```
  Supports `insert`, `replace`, `update`, `delete` (update/delete by-query too).
  An empty line or a change of target table commits the current transaction.
  Response: `{ "items": [...], "errors": false, ... }`.
- `POST /search` (alias `/json/search`) — JSON query DSL:
  `{ "table": "products", "query": { "match": { "title": "bag" } }, "limit": 20, "offset": 0 }`
  (`size`/`from` are synonyms for `limit`/`offset`; `index` alias for `table`).
  Response is the same hits shape as `/sql` above.

Elasticsearch-compatible endpoints (`/{table}/_doc`, `/{table}/_create`,
`/_bulk`, `/{table}/_update/{id}`, etc.) also exist for migration scenarios —
not needed here.

### 4.4 Authentication (only if the target Manticore has it enabled)

- If auth is enabled, HTTP clients must send **Basic auth** or a **Bearer
  token**:
  - `Authorization: Basic <base64(user:pass)>`, or
  - `Authorization: Bearer <token>`.
- Bearer tokens are created/rotated by the Manticore admin via
  `POST /token` (returns the raw token once).
- Responses: `401 Unauthorized` = missing/invalid credentials;
  `403 Forbidden` = authenticated but lacking the required permission.
- This tool: each saved connection may optionally carry a username+password
  (Basic) or a bearer token. Forward it as the `Authorization` header on every
  request to that node. If the node has no auth, send nothing.

### 4.5 Content types

- All Manticore HTTP endpoints respond with `application/json`.
- `/sql` accepts a raw-text or URL-encoded body. JSON endpoints accept a JSON
  body. `/bulk` requires `application/x-ndjson`.

### 4.6 Table DDL — CREATE / DROP / ALTER (run via `/sql?mode=raw`)

Powers the GUI table manager. Manticore runs in **RT (real-time) mode**, so
tables are created and dropped on the fly. The `id` column (bigint) is
**implicit — do NOT declare it**.

Create:

```
CREATE TABLE [IF NOT EXISTS] <name> (
  <col> <type> [text-modifiers],
  ...
) [<option>='<value>' ...]
```

Example the form should be able to produce:

```
CREATE TABLE articles (
  title text indexed stored,
  body text indexed,
  slug string,
  views int,
  price float,
  is_published bool,
  meta json,
  created_at timestamp,
  tags multi
) min_infix_len='2' morphology='stem_en'
```

Clone an existing schema: `CREATE TABLE <new> LIKE <existing>`.

**Column types the GUI form should offer** (verified against the manual):

| Type          | Meaning                        | Notes |
|---------------|--------------------------------|-------|
| `text`        | full-text field (searchable)   | uses the modifiers below; default is `indexed stored` |
| `string`      | string attribute               | exact value; filter/sort/group, NOT full-text |
| `int`/`integer` | unsigned 32-bit integer      | shown as `uint` in `DESC` |
| `bigint`      | signed 64-bit integer          | |
| `float`       | 32-bit IEEE-754 float          | |
| `bool`        | boolean (1-bit)                | |
| `json`        | JSON attribute                 | |
| `timestamp`   | unix timestamp                 | |
| `multi`       | MVA — array of uint            | multi-valued attribute |
| `multi64`     | MVA — array of bigint          | multi-valued attribute |
| `float_vector`| vector of floats               | KNN/embeddings; advanced, keep optional |

**Text-field modifiers** (space-separated, only for `text` columns):

- `indexed` — full-text searchable.
- `stored` — original value kept on disk and returned in results.
- `attribute` — also usable as an attribute.
- Common combos: `text indexed stored` (default), `text indexed` (searchable,
  not returned), `text stored` (returned, not searchable).

**Optional CREATE options** (expose a few as an "advanced" section):

- `min_infix_len='2'` / `min_prefix_len='2'` — enable infix/prefix (wildcard) search.
- `morphology='stem_en'` (also `lemmatize_en`, etc.) — stemming/lemmatization.
- `engine='columnar'` | `engine='rowwise'` — storage engine.
- `rt_mem_limit='128M'` — RAM chunk size.

**Drop / truncate / alter:**

- `DROP TABLE [IF EXISTS] <name>`
- `TRUNCATE TABLE <name>` — empties the table, keeps the schema.
- `ALTER TABLE <name> ADD COLUMN <col> <type>`
- `ALTER TABLE <name> DROP COLUMN <col>`
- Note: only RT tables support insert/edit/`ALTER`. `SHOW TABLES` returns the
  table type; the GUI should note (or disable edit actions) when a table's type
  is not `rt`. `ALTER` is unavailable on tables that are part of a replication
  cluster.

**Escaping:** the table name and column names come from user input. Validate
identifiers against `^[A-Za-z_][A-Za-z0-9_]*$` before interpolating them into
DDL; reject anything else rather than trying to escape it.

---

## 5. Development / test node

A test Manticore node is available on the LAN:

- **HTTP API base:** `http://192.168.1.75:9318`  ← the tool connects here
- **SQL (MySQL) port:** `9316`  ← intentionally unused by this tool

Smoke test the agent/owner can run from the same network:

```bash
curl -s "http://192.168.1.75:9318/sql?mode=raw" -d "SHOW TABLES"
curl -s "http://192.168.1.75:9318/sql?mode=raw" -d "SELECT 1"
```

Seed some data to test browsing/CRUD (RT table + rows):

```bash
curl -s "http://192.168.1.75:9318/sql?mode=raw" -d "DROP TABLE IF EXISTS demo"
curl -s "http://192.168.1.75:9318/sql?mode=raw" -d "CREATE TABLE demo(title text, price float)"
curl -s "http://192.168.1.75:9318/sql?mode=raw" -d "INSERT INTO demo(id,title,price) VALUES(1,'first',9.9),(2,'second',19.5)"
curl -s "http://192.168.1.75:9318/sql?mode=raw" -d "SELECT * FROM demo"
```

The default HTTP port is normally 9308; this node uses 9318, which is exactly
why connections must store an explicit host + port.

---

## 6. Suggested project structure

```
/
  AGENTS.md
  README.md
  package.json            # "type":"module"; deps: better-sqlite3 only
  package-lock.json
  .gitignore              # node_modules, data/, *.sqlite*, .env
  src/
    server.js             # node:http server + top-level routing
    config.js             # env parsing (PORT, ADMIN_PASSWORD, SESSION_SECRET, APP_DB_PATH)
    router.js             # tiny helper: match method+path, parse body (optional)
    manticore.js          # fetch wrappers for the Manticore HTTP API (section 4)
    db.js                 # better-sqlite3: connections + sessions tables, migrations
    auth.js               # scrypt hashing, signed-cookie sessions, requireAuth guard
    html.js               # escapeHtml + small render helpers
    routes/
      api.js              # JSON endpoints: connections CRUD, run-sql proxy, row CRUD
      pages.js            # server-rendered HTML page handlers
    views/
      layout.js           # HTML shell (head, nav, <link> styles, <script> app.js)
      login.js
      dashboard.js        # connection list + add/edit form
      browse.js           # table list + data grid
      console.js          # SQL console page
      components.js       # reusable HTML snippets (table, form, alert)
  public/
    app.js                # vanilla client JS: run query, render result tables, inline edit
    styles.css            # plain CSS
  data/
    app.sqlite            # created at runtime (gitignored)
```

Keep it flatter if the app stays small — do not over-engineer folders.

---

## 7. Conventions

- **Server & routing:** in `server.js`, create the server with
  `http.createServer`. Route on `req.method` and
  `new URL(req.url, 'http://localhost').pathname`. Split handlers into
  `routes/api.js` (returns JSON) and `routes/pages.js` (returns HTML).
- **Reading request bodies:** collect `req` stream chunks into a buffer, then
  parse as JSON / urlencoded as needed (a small helper in `router.js` is fine).
  Guard against oversized bodies.
- **Static files:** serve `public/` with `fs.readFile` + a small extension →
  Content-Type map. No static-server dependency.
- **Talking to Manticore:** all in `manticore.js`. Use global `fetch` with an
  `AbortController` timeout. Central `runSql(conn, sql)` → `POST
  {conn.baseUrl}/sql?mode=raw` with the SQL as the raw body and the optional
  `Authorization` header; return the parsed JSON array of result sets. For row
  edits, do NOT build SQL by naive concat with un-escaped user values — escape
  strings (`'` -> `''`) and validate identifiers, or use the JSON CRUD
  endpoints (4.3) for row writes.
- **HTML rendering:** plain template-literal functions returning strings. No JSX,
  no template engine. **Always HTML-escape** any value coming from Manticore or
  user input (`escapeHtml` in `html.js`) to prevent XSS.
- **Client JS:** one `public/app.js`, served as-is (no bundling). Use `fetch`
  against the JSON API and build DOM by hand. Keep it small.
- **App DB:** `better-sqlite3` prepared statements, raw SQL. On startup run
  idempotent `CREATE TABLE IF NOT EXISTS` migrations in `db.js`.
- **Secrets & config:** never hardcode. Read from env in `config.js`. Fail fast
  with a clear message if a required env var is missing.
- **Errors:** API handlers return JSON `{ "error": "..." }` with a correct HTTP
  status. Never swallow Manticore errors — pass `error`/`warning` through.

---

## 8. Security

This tool can read/modify databases, so treat it as sensitive.

- Require login for every page and API route except the login page/handler and
  static assets. Implement a `requireAuth` guard and apply it centrally.
- Admin password from `ADMIN_PASSWORD` env, verified with `scrypt`
  (`crypto.scryptSync(password, salt, 64)`, compared with `timingSafeEqual`).
  Alternatively store a salted hash in `data/app.sqlite` with a first-run setup
  flow — pick one and document it in README.
- Sessions: random id from `crypto.randomBytes` in an **HttpOnly**,
  **SameSite=Strict**, **Path=/** cookie; add **Secure** when served over HTTPS.
  Sign the cookie value with `crypto.createHmac` and verify on each request.
  Store sessions in `data/app.sqlite` with an expiry; sweep expired rows.
- Saved-connection credentials (bearer tokens / passwords) live in
  `data/app.sqlite`. README must warn the file needs protecting; encryption at
  rest is out of scope unless requested.
- Escape all DB-derived output in HTML. The SQL console intentionally allows
  arbitrary SQL — that is by design for an admin tool, and is exactly why auth
  is mandatory.

---

## 9. Commands

`package.json` scripts:

- `npm start`   -> `node src/server.js`
- `npm run dev` -> `node --watch src/server.js`

Environment variables:

- `PORT` (default `3000`) — port the admin UI listens on.
- `ADMIN_PASSWORD` (required) — admin login password.
- `SESSION_SECRET` (required) — secret for signing session cookies.
- `APP_DB_PATH` (default `./data/app.sqlite`) — path to the app's SQLite file.

`node_modules/`, `data/`, `*.sqlite*`, and `.env` must be gitignored.

---

## 10. Build order (suggested)

1. `config.js` + `db.js` (schema: `connections`, `sessions`) + `manticore.js`
   with a `runSql` wrapper and a `ping`/`SHOW TABLES` smoke test against the
   test node in section 5.
2. `auth.js` + login page + session guard.
3. Dashboard: list / add / edit / delete connections; "test connection" button
   (calls `SHOW VERSION` / `SELECT 1`).
4. Browse: `SHOW TABLES` -> `DESC <t>` -> paginated `SELECT * FROM <t> LIMIT ...`
   grid built from `columns` + `data`, with a search box.
5. Table management (GUI, section 4.6): "New table" form (name + dynamic column
   rows: name, type dropdown, and — for `text` — indexed/stored/attribute
   checkboxes, plus an optional "advanced options" section); drop table (with
   confirm); optional add/drop column and truncate on the table view.
6. Row CRUD via forms (INSERT / REPLACE / UPDATE / DELETE — SQL through
   `/sql?mode=raw`, or the JSON endpoints in 4.3).
7. SQL console: textarea -> `/sql?mode=raw` -> render each result set's
   `columns`/`data`, plus any `error`/`warning`.
8. Polish: styling, empty states, error toasts.

Ship a minimal `README.md` with install/run/env instructions.

---

## 11. Definition of done

- Runs with `npm start` and a couple of env vars; no build step.
- `package.json` has no runtime deps beyond `better-sqlite3`.
- Auth works; unauthenticated access is blocked everywhere it should be.
- Against the test node (`http://192.168.1.75:9318`): can add the connection,
  create a table via the GUI form, browse a table, edit a row, drop a table, and
  run SQL — all through the browser.
- Manticore `error`/`warning` and app errors are shown clearly, never swallowed.

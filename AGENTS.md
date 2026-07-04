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

**GUI-first principle (important for this iteration).** Everything a normal
admin does day-to-day must be doable through the GUI with zero SQL typing:
creating tables, adding/removing columns, dropping/truncating, browsing, and
full type-aware row CRUD. The SQL console is a power-user escape hatch, never a
required step for any common task. For every schema or destructive action the
GUI performs, build the statement for the user and show a **read-only SQL
preview of exactly what will run** before executing, and require a confirm step
for destructive operations (DROP TABLE, TRUNCATE, DROP COLUMN, DELETE row). The
preview keeps the tool transparent while keeping SQL optional.

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
- Do NOT add a UI component library or its runtime — no MUI / `@mui/material`
  (that is React), no `@material/web` / Material Web Components, no Bootstrap,
  no Shoelace. The Material Design 3 look is implemented by hand as CSS tokens +
  small vanilla JS (see §13). "Material 3" here means the **design language**,
  not a component dependency.
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

**64-bit integers — do NOT lose precision through JSON (verified against the
node, report F2).** Manticore `id` and any `bigint` / `multi64` values are
64-bit. Auto-generated ids are large (e.g. `8506583095909023745`), well above
JavaScript's safe-integer limit (2^53). A plain `JSON.parse` of Manticore's
response coerces these to float64 and silently corrupts them — the grid shows a
rounded id, and Edit/Delete then hit a non-existent row; writes can also mangle
bigint columns. Requirements:
- When parsing Manticore JSON responses, preserve large integers losslessly
  (e.g. wrap integer literals in the value position as strings before
  `JSON.parse`, or use a bigint-aware parser). Treat `id` as an opaque string
  throughout the app.
- When *building* SQL/JSON that carries an id or bigint, format it from a
  string / `BigInt`, never via `Number()`.

### 4.2 Introspection queries (run via `/sql?mode=raw`)

- `SHOW TABLES` — list tables (rows: table name + type).
- `DESC <table>` / `DESCRIBE <table>` — schema rows: `Field`, `Type`, `Properties`.
- `SHOW CREATE TABLE <table>` — prints the exact `CREATE TABLE` statement. Use it
  to power "view definition" / "edit schema" / "duplicate table" and to pre-fill
  forms. Never hand-reconstruct a schema you can read verbatim this way.
- `SHOW TABLE <table> STATUS` — stats incl. row count, disk size, RAM chunk.
- `SHOW TABLE <table> SETTINGS` — the table's configured settings/options.
- `SELECT * FROM <table>.@table` — schema as a queryable virtual table
  (`id, field, type, properties`); useful when you want to filter columns.
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

**Text / string field modifiers** (space-separated). `text` and `string` share
the same modifier grammar; the manual lists these exact combinations:

- `text` (== `text indexed stored`) — full-text indexed AND original value
  stored in docstore (searchable + returned as-is). This is what a bare `text`
  means.
- `text indexed` / `string indexed` — full-text indexed only; original value is
  NOT stored (searchable, not returned as-is).
- `text indexed attribute` / `string indexed attribute` — full-text indexed AND
  also a string attribute (filter/sort/group); original not stored.
- `text stored` / `string stored` — value only stored in docstore; not indexed,
  not an attribute (returned, not searchable, not filterable).
- Bare `string` — string attribute only (filter/sort/group/REGEX, not
  full-text). Add `indexed` to also make it full-text searchable.

Do NOT put the `stored_only_fields` option in `CREATE TABLE` — it is not
supported there and will make the statement fail. Use the `stored` field
property instead.

**Optional CREATE options** (expose a few as an "advanced" section):

- `min_infix_len='2'` / `min_prefix_len='2'` — enable infix/prefix (wildcard) search.
- `morphology='stem_en'` (also `stem_ru`, `lemmatize_en_all`, `libstemmer_*`, …)
  — stemming/lemmatization.
- `html_strip='1'` — strip HTML from indexed text. `index_exact_words='1'` —
  keep exact word forms alongside stemmed ones.
- `engine='columnar'` | `engine='rowwise'` — default attribute storage for the
  table (default `rowwise`). Can also be set per attribute, e.g.
  `price float engine='columnar'`.
- `rt_mem_limit='128M'` — RAM chunk size for the RT table.
- Anything else: expose a free-text "extra options" field and pass it through
  verbatim rather than trying to model every Manticore setting.

`float_vector` (KNN) is advanced — keep it behind an "advanced" toggle. Exact
form: `embedding float_vector knn_type='hnsw' knn_dims='384' hnsw_similarity='l2'`
where `hnsw_similarity` is one of `l2` / `ip` / `cosine`. Vectors are inserted
as `(0.1,0.2,...)` tuples.

**Drop / truncate:**

- `DROP TABLE [IF EXISTS] <name>` — removes the table entirely.
- `TRUNCATE TABLE <name>` — empties the table, keeps the schema. Prefer this
  over `DELETE FROM <name>` for clearing a whole table (much faster).

**ALTER TABLE — exact syntax (verified against the manual):**

```
ALTER TABLE <name> ADD COLUMN <col>
  [{INTEGER|INT|BIGINT|FLOAT|BOOL|MULTI|MULTI64
    |JSON [secondary_index='1']|STRING|TEXT [INDEXED [ATTRIBUTE]]|TIMESTAMP}]
  [engine='columnar']
ALTER TABLE <name> DROP COLUMN <col>
ALTER TABLE <name> MODIFY COLUMN <col> bigint      -- only int -> bigint widening
ALTER TABLE <name> rt_mem_limit='1G'               -- change a table setting
```

**Hard ALTER constraints — enforce these in the GUI so it can never build an
invalid statement:**

- One column per `ALTER` — no multi-column add in a single statement.
- For existing rows, a newly added attribute is filled with `0` (empty for
  string/json). You cannot back-fill values via `ALTER`.
- `MODIFY COLUMN` only supports widening an `int` column to `bigint`. There is
  no general type-change; to change a type otherwise, add a new column (or
  recreate the table).
- `DROP COLUMN` fails if it would leave the table with no attributes at all.
- `ALTER` does not work on distributed tables, or on a table that has no
  attributes yet.
- `ALTER` is rejected for tables that belong to a replication cluster
  (error text: "ALTER is not supported for tables in cluster").
- While a column is being added the table is briefly write-locked.
- Changing tokenization/morphology settings via `ALTER` affects only rows
  inserted afterwards; existing rows keep their old processing.

**Table-type gating:** `SHOW TABLES` returns each table's type. Only `rt`
(real-time) tables support row INSERT/UPDATE/DELETE and `ALTER` / interactive
`CREATE`. For `plain`, `distributed`, `percolate`, or `template` tables the GUI
must disable (or clearly warn on) create/edit/alter actions instead of sending a
doomed statement. `plain` tables are built from a config source via the
`indexer` tool and cannot be created interactively.

**SQL value & identifier escaping (VERIFIED against the node — read carefully):**

Manticore uses MySQL / SphinxQL-style **backslash** escaping in SQL string
literals, NOT ANSI quote-doubling. Confirmed against the manual and the live node
(report F1):

- Escape a value that goes inside `'...'` by first replacing `\` with `\\`, then
  `'` with `\'`. Example: `O'Brien` -> `O\'Brien`.
- Do NOT use `'` -> `''` (ANSI doubling). Manticore parses `''` as two adjacent
  string literals, so any value with an apostrophe throws a syntax error, and —
  because `\` stays an active escape character — a value ending in `\` breaks out
  of the literal and becomes an injection vector. (This corrects an earlier
  version of this file; the fix already lives in `manticore.js` — **do not
  revert it**.)
- **Identifiers** (table / column names) are NOT escaped — validate them against
  `^[A-Za-z_][A-Za-z0-9_]*$` and reject anything else rather than escaping.
- **`MATCH()` has a second escaping layer.** Text placed inside `MATCH('...')`
  is also a full-text query, so operators (`@ ( ) ! - | / ~ " ^ $ * =`) are
  interpreted unless backslash-escaped. For a plain-text search box, escape both
  layers: escape the full-text operators with a backslash, then apply the SQL
  string-literal escaping above.
- **Lower-risk alternative — prefer JSON for writes/search.** For row writes and
  full-text search, prefer the JSON endpoints (`/insert`, `/replace`, `/update`,
  `/delete`, `/search` with a `match` clause) over hand-built SQL. Values travel
  as native JSON, so the SQL string-literal layer disappears entirely (the JSON
  encoder escapes for you). Reserve raw SQL-string building for cases that truly
  need it.

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
  edits, do NOT build SQL by naive concat with un-escaped user values — apply the
  backslash escaping + identifier validation in §4.6 (NOT `'`->`''`), or use the
  JSON CRUD endpoints (4.3) for row writes. Preserve 64-bit ids/bigints
  losslessly (§4.1) — never round-trip them through `Number()`.
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

---

## 12. QA & bug-hunt checklist

Intended as a dedicated review pass (see the two-session workflow). For each
item, confirm it holds or fix it. Focus on these classes — this is where a tool
like this actually breaks.

**Security (highest priority):**
- Every page and every API route except login + static assets sits behind the
  `requireAuth` guard. Explicitly verify the run-SQL / SQL-proxy endpoint and all
  connection-CRUD endpoints are guarded — an unauthenticated user must not be
  able to reach Manticore through this app.
- Row insert/edit/delete and GUI-built DDL do NOT concatenate raw user values
  into SQL. String values use the backslash escaping in §4.6 (`\`->`\\` then
  `'`->`\'`, NOT `'`->`''`) or the JSON CRUD endpoints (4.3); identifiers
  (table/column names) are validated against
  `^[A-Za-z_][A-Za-z0-9_]*$` and rejected otherwise.
- Every value rendered into HTML (grid cells, connection names, error text, form
  values, SQL-console output) goes through `escapeHtml`.
- Session cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` under
  HTTPS, HMAC-signed and verified; session ids from `crypto.randomBytes`;
  password compared with `timingSafeEqual`.
- Stored connection credentials (tokens/passwords) are never sent back to the
  browser in HTML or JSON.

**Correctness / robustness:**
- `error` AND `warning` from every result set are surfaced, never swallowed. In
  a multi-statement console run, a failure reports which statement failed.
- A dead/unreachable node (wrong host/port, timeout) produces a clean UI error,
  not a crash or endless spinner; `fetch` uses an `AbortController` timeout.
- Empty states render: 0-row table, 0-table node, SELECT with no columns,
  non-`rt` table (edit/alter disabled or warned).
- Pagination is correct at boundaries (first/last page, total not a multiple of
  page size); LIMIT/OFFSET are integers, never interpolated user strings.
- Oversized request bodies are rejected, not buffered unbounded.
- `id` is read-only in edit forms and never sent inside the editable `doc`.

**UX (the point of this iteration):**
- Destructive actions (DROP TABLE, TRUNCATE, DROP COLUMN, DELETE row) require a
  confirm step and show the exact statement that will run.
- Row forms use type-aware inputs (checkbox for `bool`, number for int/float,
  datetime for `timestamp`, validated textarea for `json`, etc.).
- Common tasks (create table, add/drop column, drop/truncate, full row CRUD) are
  reachable from the GUI without opening the SQL console.

Report findings as a short list of `{file, issue, severity, fix}`; fix the
high/critical items in the same session and list the rest.

---

## 13. Material Design 3 design system (vanilla CSS, no deps)

The UI must look and feel like **Material Design 3 (Material You)** — cohesive
color, type, shape, elevation, motion — implemented entirely as hand-authored
CSS custom properties + small vanilla JS. No component library (see §2). All
token values below are verified against the M3 spec / Material tokens; use them
verbatim so the system stays coherent.

Put tokens in `public/tokens.css` (`:root` for light, a `[data-theme="dark"]`
selector on `<html>` for dark) and component styles in `public/styles.css`.
Reference tokens everywhere; never hardcode a raw color/size in component CSS.

### 13.1 Color — generate once, commit as static CSS (do NOT hand-invent hex)

M3 color roles are derived from tonal palettes via the HCT color space. Do not
try to compute palettes by hand — you will get them subtly wrong. Instead:

1. Generate the scheme once from a single seed color using **Material Theme
   Builder** (https://m3.material.io/theme-builder, "Export → Web (CSS)") or the
   `material-color-utilities` package run as a one-off generator.
2. Commit the exported CSS as `public/tokens.css`. This is a **build-time /
   one-off** step — the app ships the static CSS and has **no runtime
   dependency**. Do not wire the generator into the app or a build step.

Emit the full set of role tokens as `--md-sys-color-<role>` for BOTH light and
dark. Complete role list (must all be present):

```
primary  on-primary  primary-container  on-primary-container
secondary  on-secondary  secondary-container  on-secondary-container
tertiary  on-tertiary  tertiary-container  on-tertiary-container
error  on-error  error-container  on-error-container
surface  on-surface  surface-variant  on-surface-variant
surface-dim  surface-bright
surface-container-lowest  surface-container-low  surface-container
surface-container-high  surface-container-highest
background  on-background
outline  outline-variant
inverse-surface  inverse-on-surface  inverse-primary
surface-tint  shadow  scrim
```

Role→tone mapping (for reference / sanity-checking the export): in light,
`primary`=tone40, `on-primary`=tone100, `primary-container`=tone90,
`on-primary-container`=tone10; in dark those become tone80 / tone20 / tone30 /
tone90 respectively. Same pattern for secondary/tertiary/error.

Baseline seed to start with (if the owner has no brand color): `#6750A4`
(the M3 default). Regenerating with a different seed later is a one-file swap.

Usage: page background = `surface`; text = `on-surface`; cards/menus/dialogs use
the `surface-container*` roles (higher container = more "raised"); primary
actions use `primary` / `on-primary`; the SQL console and code use
`surface-container` + `on-surface`; errors/warnings use `error-container` /
`on-error-container`.

### 13.2 Typography — M3 type scale (Roboto)

Load Roboto + Material Symbols via one `<link>` each (Google Fonts CDN is a
static asset link, not a JS dependency). Define each role as a token bundle and
apply per element. Values are `size / line-height / weight / letter-spacing`:

```
display-large    57px / 64px / 400 / -0.25px
display-medium   45px / 52px / 400 /  0
display-small    36px / 44px / 400 /  0
headline-large   32px / 40px / 400 /  0
headline-medium  28px / 36px / 400 /  0
headline-small   24px / 32px / 400 /  0
title-large      22px / 28px / 400 /  0
title-medium     16px / 24px / 500 /  0.15px
title-small      14px / 20px / 500 /  0.1px
body-large       16px / 24px / 400 /  0.5px
body-medium      14px / 20px / 400 /  0.25px
body-small       12px / 16px / 400 /  0.4px
label-large      14px / 20px / 500 /  0.1px
label-medium     12px / 16px / 500 /  0.5px
label-small      11px / 16px / 500 /  0.5px
```

Rough mapping for this app: page/section titles → headline-small / title-large;
table headers → title-small; table cells and form text → body-medium; buttons
and chips → label-large; helper/caption text → body-small.

### 13.3 Shape — corner radius scale

```
none 0   extra-small 4px   small 8px   medium 12px   large 16px
extra-large 28px   full 9999px (pill)
```

Component defaults: buttons, chips-as-actions, FAB target → `full`; cards,
menus, snackbars → `medium` (12); text fields (filled) → `extra-small` top
corners only (4 4 0 0); dialogs, bottom sheets → `extra-large` (28); large
containers/panels → `large` (16).

### 13.4 Elevation — 6 levels (shadow-based)

Levels 0–5 (dp 0 / 1 / 3 / 6 / 8 / 12). Use these exact box-shadows:

```
level0: none
level1: 0 1px 2px 0 rgba(0,0,0,.30), 0 1px 3px 1px rgba(0,0,0,.15)
level2: 0 1px 2px 0 rgba(0,0,0,.30), 0 2px 6px 2px rgba(0,0,0,.15)
level3: 0 1px 3px 0 rgba(0,0,0,.30), 0 4px 8px 3px rgba(0,0,0,.15)
level4: 0 2px 3px 0 rgba(0,0,0,.30), 0 6px 10px 4px rgba(0,0,0,.15)
level5: 0 4px 4px 0 rgba(0,0,0,.30), 0 8px 12px 6px rgba(0,0,0,.15)
```

Typical: cards/raised surfaces = level1 (rest) → level2 or 3 on hover; menus =
level2; dialogs = level3; FAB = level3 (→ level4 on hover); nav drawer = level1.

### 13.5 Motion — easing + duration tokens (the heart of "animations")

Easing (cubic-bezier), verified against M3:

```
standard              cubic-bezier(0.2, 0, 0, 1)
standard-accelerate   cubic-bezier(0.3, 0, 1, 1)
standard-decelerate   cubic-bezier(0, 0, 0, 1)
emphasized            cubic-bezier(0.2, 0, 0, 1)      /* single-bezier fallback */
emphasized-decelerate cubic-bezier(0.05, 0.7, 0.1, 1)
emphasized-accelerate cubic-bezier(0.3, 0, 0.8, 0.15)
```

Durations:

```
short1 50   short2 100  short3 150  short4 200
medium1 250 medium2 300 medium3 350 medium4 400
long1 450   long2 500   long3 550   long4 600
extra-long1 700 … extra-long4 1000  (ms)
```

Which to use:
- Small state changes (hover/press/focus state layers, ripples, switches):
  `short2`–`short4` with `standard`.
- Enters (dialogs, menus, snackbars, expanding rows): `medium2`–`medium4` with
  `emphasized-decelerate`. Exits: one step shorter with `emphasized-accelerate`.
- Element position/size changes across the screen: `emphasized`.
- Keep routine web UI snappy (150–300ms); avoid parallax and heavy blur; animate
  `transform`/`opacity`, not layout properties.

### 13.6 State layers & ripple

Interactive elements get a **state layer**: an overlay of the element's "on"
color at these opacities (M3): hover `0.08`, focus `0.10`, pressed `0.10`,
dragged `0.16`. Implement as an `::before`/overlay tinted with the on-color and
transitioned with `short` + `standard`. Add a **ripple** on press for buttons,
list rows, icon buttons, chips, tabs — a small vanilla JS helper that spawns an
expanding circle from the pointer position, colored with the on-color at ~12%,
fading over `long1`. Focus states must remain visible with keyboard (`:focus-visible`).

### 13.7 Components to build (map to existing screens)

Style these as MD3, reusing token vars: top app bar (with title + actions);
navigation rail or drawer for connection/table navigation; buttons — filled
(primary actions), tonal (secondary), outlined, text; FAB or extended FAB for
the primary "add" action (add connection / create table); cards for the
connection list and the table list (surface-container, level1, medium radius);
text fields — filled and/or outlined, with floating label, helper/error text,
and the required focus/error state colors; dropdown menus and the type-select in
the create-table form; chips for table-type / column-property tags; dialogs
(extra-large radius, level3, scrim) for the destructive-action confirmations and
the SQL preview; snackbar/toast for transient success/error; a Material-styled
data table for the browse grid (dense rows, on-surface-variant headers, hover
state layer on rows); switches/checkboxes for `bool` inputs. Icons: Material
Symbols.

### 13.8 Accessibility & polish (required, not optional)

- Honor `@media (prefers-reduced-motion: reduce)`: disable/last-frame all
  transitions, ripples, and entrance animations.
- Respect `prefers-color-scheme` for the initial light/dark choice; also allow a
  manual toggle that sets `data-theme` on `<html>`. (Persisting the choice
  server-side is fine; do NOT use localStorage in a way that breaks without JS.)
- Contrast comes for free if you pair each surface with its matching `on-` role;
  never put `on-surface` text on a `primary` fill, etc.
- Minimum 48x48px touch/click targets for interactive controls.
- Keep the SQL console and result grid readable — this is a data tool first; MD3
  styling must not reduce information density to the point of being annoying.

Definition of done for this iteration: the app is visually coherent MD3 across
all screens, light+dark, with tasteful entrance/state/ripple motion, and still
passes everything in §12 (no dependency added, no build step, no regressions to
the escaping/bigint/auth fixes).
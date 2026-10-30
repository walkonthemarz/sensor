# AGENTS.md

Instructions for coding agents working in this repository. Read this first;
`README.md`, `PRODUCT.md`, and `DESIGN.md` remain the user-facing references.

## What this project is

An end-to-end indoor air quality monitor built around one M701 sensor:

```
M701 sensor ──USB serial──▶ client (Rust) ──HTTPS POST──▶ server (Axum) ──▶ PostgreSQL
                                                              │
                                                              └──▶ static dashboard
```

- `client/` — `sensor_reader`, a Rust binary that reads 17-byte M701 UART frames.
- `server/` — `sensor_server`, an Axum + SQLx + PostgreSQL API that also serves
  the dashboard from `server/assets/`.
- `deploy/` — Cloudflare Tunnel, Caddy, and systemd templates.
- `docs/` — frame specification and screenshots.

There is **no frontend framework, bundler, or build step**. The dashboard is
plain HTML/CSS/JS plus a vendored `chart.umd.min.js`, compiled into the server
image as static files.

## Toolchain

- Rust stable, edition 2024 (workspace resolver 2).
- PostgreSQL for the server; `sqlx-cli` for migrations.
- Linux serial access (`libudev`/`pkg-config` are needed to build `serialport`).
- Node.js >= 20 and pnpm for the task runner only.

### pnpm is the canonical entry point

`package.json` and `pnpm-lock.yaml` define the project's task runner. Use pnpm
for every documented workflow; do not introduce npm or yarn lockfiles.

```bash
corepack enable          # once, so the pinned pnpm version is used
pnpm install             # no JS dependencies today; installs the pinned pnpm
```

If `corepack enable` cannot write to the system Node bin directory, use
`corepack enable --install-directory ~/.local/bin` instead. Commit
`pnpm-lock.yaml`; `node_modules/` is already gitignored.

`.prototools` (proto) also pins a pnpm version for machines that use it.
`package.json` holds the exact `packageManager` version and is the source of
truth.

Useful scripts (all run from the repository root):

| Command | What it does |
| :--- | :--- |
| `pnpm dev:server` | Run the API from `server/` (needs PostgreSQL + `.env`) |
| `pnpm dev:client -- --port /dev/ttyACM0` | Run the serial reader in release mode |
| `pnpm build` | Release build of the whole workspace into `target/release/` |
| `pnpm check` | `cargo check --workspace --all-targets` |
| `pnpm test` | `cargo test --workspace` |
| `pnpm fmt` / `pnpm fmt:check` | Apply / verify rustfmt |
| `pnpm clippy` | Clippy with `-D warnings` |
| `pnpm lint` | `fmt:check` + `clippy`; run before finishing |
| `pnpm ci` | `lint` + `test`; mirrors the blocking CI checks |
| `pnpm migrate` | Apply migrations from `server/migrations/` |
| `pnpm migrate:add <name>` | Create a new SQLx migration |
| `pnpm docker:up` / `pnpm docker:down` | Manage the Compose stack in `server/` |

Cargo still works directly; pnpm only wraps it. If a script needs new behavior,
add it to `package.json` rather than documenting an ad-hoc command elsewhere.

## Local setup

1. Rust stable and `libudev-dev` + `pkg-config` (Debian/Ubuntu) for the client.
2. PostgreSQL running, or the Compose stack under `server/`.
3. `cp server/.env.example server/.env` and `cp client/.env.example client/.env`,
   then set a shared `SENSOR_API_KEY` on both sides.
4. `pnpm migrate` once the database exists.
5. `pnpm dev:server`, then `pnpm dev:client -- --port /dev/ttyACM0 --server-url http://127.0.0.1:3000/api/readings`.

## Architecture notes and gotchas

### Run the server from `server/`

The server resolves `assets/` relative to the working directory and loads
`server/.env` with `dotenvy`. Running it from the repository root serves no
dashboard and misses the config. The `dev:server`, `migrate`, and Docker scripts
already `cd` into `server/`.

### Build artifacts live at the workspace root

`cargo` resolves the workspace root, so release binaries land in
`target/release/` at the repository root, not `server/target/`. The systemd
units under `deploy/systemd/` expect `~/sensor/target/release/{sensor_server,sensor_reader}`.
Keep that path stable.

### Migrations

- SQLx migrations live in `server/migrations/` and are embedded by path only
  through the `sqlx` CLI. The server itself does **not** run them at startup.
- `server/docker-entrypoint.sh` runs `sqlx migrate run` before starting the API.
  For the rootless deployment, run `pnpm migrate` (or the SQL file) manually.
- Never edit a migration that has shipped; add a new timestamped one.

### API contract — do not break it

- `POST /api/readings` requires the `x-api-key` header to equal
  `SENSOR_API_KEY`; body fields are `eco2`, `ech2o`, `tvoc`, `pm2_5`, `pm10`,
  `temperature`, `humidity`.
- `GET /api/readings` is public and returns the latest 100 rows, globally rate
  limited to 120 requests/minute with `429` + `Retry-After` when exhausted.
- Timestamps are stored and returned as **naive UTC**; the dashboard appends
  `Z` and localizes in the browser. Keep that behavior consistent.
- The client posts `application/json`; keep field names and units unchanged.

### Dashboard assets (PWA)

Everything in `server/assets/` is served with `Cache-Control: no-cache`. When
changing the app shell:

1. Bump the `?v=` query on script tags in `server/assets/index.html`.
2. Use the same versioned URLs in `SHELL` in `server/assets/sw.js` and bump its
   `VERSION`.
3. Keep `manifest.webmanifest` icon sizes in sync with `assets/icons/`.
4. Never cache `POST` requests in the service worker.

`chart.umd.min.js` is vendored on purpose (offline/PWA, no CDN). Do not add a
CDN dependency or a bundler. If a JS package is ever truly required, discuss it
first; adding one means a build step in `server/Dockerfile` and CI.

### Design work

`DESIGN.md` is the visual contract and `PRODUCT.md` is the product contract.
Match existing tokens, typography, spacing, and component patterns; do not
introduce a second typeface, a framework, or network font requests. Preserve
accessibility: keyboard focus, `prefers-reduced-motion`, semantic table markup,
live status announcements, and never encode state with color alone.

### Deployment

Public traffic is terminated by Cloudflare Tunnel for `sensor.boxcube.xyz`,
forwarded to Caddy on `127.0.0.1:8080`, then to the API. Compose is the preferred
target; the live box currently uses the no-sudo systemd setup in
`deploy/rootless/`. Read `server/DEPLOYMENT.md` and `deploy/README.md` before
changing units, ports, or proxy config.

### Secrets

`.env`, TLS material, and certificates are gitignored. Never commit real keys.
`SENSOR_API_KEY` must be set on both client and server; the server logs an error
and rejects writes without it.

## Coding conventions

- Follow surrounding style; run `pnpm fmt` before committing.
- `edition = "2024"`; both binaries return `anyhow::Result` and use `anyhow`
  context instead of panics for runtime failures.
- Server data structures use `serde` for the API and `sqlx::FromRow` for
  queries. Keep SQL in `server/migrations/` and bound parameters in queries.
- Prefer small, focused modules over new dependencies. Justify any new crate.
- The repository was assembled with `git subtree`; `client/` and `server/` keep
  their original histories. Do not rewrite history or squash it away.

## Verification before finishing

Run, at minimum:

```bash
pnpm fmt:check
pnpm clippy
pnpm test
```

For dashboard changes, also load the page from `server/` and check the fresh,
stale/waiting, offline, mobile, and reduced-motion states. For API changes, hit
`POST` with and without the key and confirm `GET` still returns the documented
shape.

The blocking CI job (`.github/workflows/ci.yml`) runs `cargo test --workspace`
on Ubuntu after installing `libudev-dev` and `pkg-config`.

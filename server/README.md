# Sensor Server

A Rust-based web server built with [Axum](https://github.com/tokio-rs/axum) for collecting and serving environmental sensor data.

## Features

-   **Data Collection**: Accepts sensor readings (CO2, Temperature, Humidity, PM2.5, etc.) via a REST API.
-   **Data Storage**: Persists data in a PostgreSQL database.
-   **API Access**: Provides endpoints to retrieve recent sensor readings.
-   **Static File Serving**: Serves a frontend dashboard from the `assets` directory.
-   **Installable dashboard**: The dashboard ships a manifest and service worker, so it installs as an app and still shows the last known readings offline.
-   **Security**: Supports HTTPS (TLS) and API Key authentication for data ingestion.

## Configuration

The server is configured via environment variables. You can set these in a `.env` file in the project root.

| Variable | Description | Default |
| :--- | :--- | :--- |
| `HOST` | The interface to bind to | `127.0.0.1` |
| `PORT` | The port to listen on | `3000` |
| `SENSOR_API_KEY` | **Required** for `POST` requests. The shared secret with the client. | *None* |
| `DATABASE_URL` | PostgreSQL connection string | *None* |
| `RETENTION_DAYS` | Days of readings to keep; cleanup runs hourly, `0` disables it | `7` |
| `VAPID_PRIVATE_KEY` | URL-safe base64 P-256 private key for Web Push alerts; empty disables alerts | *None* |
| `VAPID_SUBJECT` | VAPID contact, `mailto:...` or `https://...`; required with the private key | *None* |
| `VAPID_PUBLIC_KEY` | Optional; only used to verify it matches the private key | *Derived* |
| `POSTGRES_USER` | PostgreSQL username (Docker only) | `sensor_user` |
| `POSTGRES_PASSWORD` | PostgreSQL password (Docker only) | *None* |
| `POSTGRES_DB` | PostgreSQL database name (Docker only) | `sensor_data` |

## API Endpoints

### `POST /api/readings`

Submit a new sensor reading.

**Headers:**
-   `Content-Type: application/json`
-   `x-api-key: <YOUR_SENSOR_API_KEY>`

**Body:**
```json
{
  "eco2": 400,
  "ech2o": 10,
  "tvoc": 50,
  "pm2_5": 12,
  "pm10": 15,
  "temperature": 25.5,
  "humidity": 60.0
}
```

### `GET /api/readings`

Retrieve the latest 100 readings.

The endpoint is rate limited **globally** to **120 requests per minute** (token
bucket with a burst of 120). When the budget is exhausted the server responds
with `429 Too Many Requests` and a `Retry-After` header. `POST` traffic is not
counted; it remains protected by the API key.

**Response:**
```json
[
  {
    "id": 1,
    "timestamp": "2023-10-27T10:00:00",
    "eco2": 400,
    ...
  }
]
```

### `GET /api/push/key`

Public. Returns the VAPID public key the dashboard needs before it can create a
push subscription:

```json
{ "publicKey": "B..." }
```

Returns `503` when `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` are not configured.

### `POST /api/push/subscribe`

Public. Stores a browser `PushSubscription`. The body is the object returned by
`subscription.toJSON()`, so `expirationTime` is ignored:

```json
{
  "endpoint": "https://web.push.apple.com/...",
  "keys": { "p256dh": "B...", "auth": "..." }
}
```

Endpoints are restricted to the well-known Apple, Google, Mozilla, and Microsoft
push services because the server POSTs to them. Dead subscriptions (`404`/`410`)
are deleted automatically.

### `DELETE /api/push/subscribe`

Public. Removes a subscription by endpoint:

```json
{ "endpoint": "https://web.push.apple.com/..." }
```

## Data Retention

The server deletes readings older than `RETENTION_DAYS` (default **7**) once at
startup and then hourly. Deletes compare against UTC wall-clock time and use the
index from `migrations/*_add_readings_timestamp_index.sql`, so they stay cheap as
the table grows. Set `RETENTION_DAYS=0` to keep readings indefinitely.

Each run logs the number of pruned rows; a no-op run only logs at debug level.
If several server instances share the database, they can all run the task — the
delete is idempotent.

## Air Quality Alerts

The server can send a browser push notification when the air stays poor. It
uses standard Web Push with VAPID; no Apple developer account or APNs
certificate is involved.

The dashboard opens the "Alerts" button only when the browser supports Web Push
and `/api/push/key` is configured. On iOS this means the PWA must be installed
on the Home Screen (iOS 16.4+). The permission prompt appears only after a tap.

### Thresholds and pacing

A reading is "bad" when any air channel crosses its dashboard band:

| Channel | Bad at |
| :--- | ---: |
| CO₂ | ≥ 1200 ppm |
| PM2.5 | ≥ 35 µg/m³ |
| PM10 | ≥ 100 µg/m³ |
| TVOC | ≥ 600 µg/m³ |
| HCHO | ≥ 150 µg/m³ |

To avoid a notification every second:

- Air must stay bad for **30 seconds** before the first alert.
- The same episode notifies **once**; a new episode is suppressed for **1 hour**
  after the previous notification.
- Air must be good for **2 minutes** to end the episode. Recovery is silent.

The state lives in the `alert_state` table, so a restart does not re-alert the
same episode.

### Setup

1. Generate a VAPID pair (URL-safe base64, no padding):

   ```bash
   pnpm vapid:keys
   ```

2. Put the private key and a contact in `server/.env`:

   ```bash
   VAPID_PRIVATE_KEY=...
   VAPID_SUBJECT=mailto:you@example.com
   ```

   `VAPID_PUBLIC_KEY` is optional. The server derives the public key from the
   private key and serves it at `GET /api/push/key`.

3. Apply the migration and restart:

   ```bash
   pnpm migrate
   pnpm dev:server
   ```

4. Open the installed PWA, tap **Alerts**, and allow notifications.

The service worker handles `push` and opens or focuses `/` when the
notification is tapped. Every push must display a notification; iOS does not
support silent data pushes.

### Testing

The alert is sent only after 30 seconds of sustained bad readings, so pause the
sensor client first; otherwise its next good reading resets the timer. Then post
a high reading every two seconds for about 35 seconds:

```bash
systemctl --user stop sensor-client

for _ in $(seq 1 18); do
  curl -sS -X POST http://127.0.0.1:3000/api/readings \
    -H "x-api-key: $SENSOR_API_KEY" \
    -H 'content-type: application/json' \
    -d '{"eco2":1350,"ech2o":10,"tvoc":50,"pm2_5":5,"pm10":5,"temperature":22,"humidity":45}' \
    >/dev/null
  sleep 2
done

systemctl --user start sensor-client
```

The notification should arrive during the loop. To test again immediately,
reset the episode and cooldown:

```sql
UPDATE alert_state
SET level = 'clear', bad_since = NULL, clear_since = NULL, last_notified_at = NULL;
```

## Database Migrations

This project uses [sqlx-cli](https://github.com/launchbadge/sqlx/tree/main/sqlx-cli) for database migration management.

### Running Migrations

**Local Development:**
```bash
# Ensure DATABASE_URL is set in your .env file
sqlx migrate run
```

**Docker:**
Migrations run automatically when the container starts.

### Creating New Migrations

```bash
# Create a new migration file
sqlx migrate add <migration_name>

# Example:
sqlx migrate add add_location_column
```

### Reverting Migrations

```bash
# Revert the last migration
sqlx migrate revert
```

## Running the Server

### Prerequisites
-   Rust (latest stable)
-   PostgreSQL (for local development)
-   sqlx-cli: `cargo install sqlx-cli --no-default-features --features postgres`

### Development
```bash
# Run locally
cargo run
```

### Production
Build the release binary:
```bash
cargo build --release
../target/release/sensor_server
```

## Deployment

`docker-compose.yml` runs PostgreSQL, the API, and Caddy as a local reverse proxy.
Public HTTPS is terminated at the Cloudflare edge by the `sensor.boxcube.xyz`
tunnel, which forwards to Caddy on `127.0.0.1:8080`. No inbound application
ports need to be exposed.

The full runbook is in [DEPLOYMENT.md](DEPLOYMENT.md).

## Dashboard app (PWA)

`assets/manifest.webmanifest` and `assets/sw.js` make the dashboard installable
and offline-capable. The worker caches the app shell plus the last successful
`GET /api/readings` payload; `POST` requests are never cached. When the cached
payload is served, the page shows the offline banner and the original fetch time.

Every file under `assets/` is served with `Cache-Control: no-cache`, so a deploy
is picked up on the next load.

When the shell changes (`index.html`, `script.js`, `chart.umd.min.js`, fonts, or
icons):

1. Bump the `?v=` value on the script tags in `index.html`.
2. Use the same versioned URL in `SHELL` in `sw.js` and bump its `VERSION`.
3. Keep `manifest.webmanifest` icon sizes in sync with `assets/icons/`.

The check-in sources for the icons are `assets/icons/app-icon.svg` and
`app-icon-maskable.svg`; the PNGs are rasterized from those.

## TODO

- [ ] Add unit tests
- [x] Add docker health checks
- [x] Add reverse proxy (Caddy + Cloudflare Tunnel)
- [x] Migrate to Postgres
- [x] Build the live dashboard
- [ ] Add authentication for UI
- [ ] Migrate to K8S
- [ ] Use Terraform/OpenTofu for infrastructure
- [ ] Add alerting/monitoring for CO2 threshold
- [ ] Add MD doc linting
- [ ] Add renovate to upgrade dependencies weekly
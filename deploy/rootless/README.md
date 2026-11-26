# Rootless fallback

The box currently runs the sensor stack as the `kenny` user because that account
cannot access the Docker socket without a sudo password. This is the live
deployment; the Docker Compose stack in `server/` is the preferred target once
Docker access is available.

## Components

| Component | Location |
| :--- | :--- |
| PostgreSQL 18 binaries | `~/pgsql` |
| PostgreSQL data | `~/pgdata` (port 5433, loopback only) |
| API binary | `~/bin/sensor_server` (copied from `~/sensor/target/release/sensor_server`) |
| Caddy | `~/caddy/caddy` (port 8080) |
| Cloudflare Tunnel | `sensor-tunnel.service` (public HTTPS) |

## Setup

```bash
# Portable PostgreSQL binaries (example release)
curl -L -o /tmp/pg.tar.gz \
  https://github.com/theseus-rs/postgresql-binaries/releases/download/18.6.1/postgresql-18.6.1-x86_64-unknown-linux-gnu.tar.gz
mkdir -p ~/pgsql && tar -xzf /tmp/pg.tar.gz -C ~/pgsql --strip-components=1
~/pgsql/bin/initdb -D ~/pgdata -U sensor_user --auth=trust --no-locale -E UTF8
~/pgsql/bin/pg_ctl -D ~/pgdata -o "-p 5433 -k /tmp" start
~/pgsql/bin/createdb -h 127.0.0.1 -p 5433 -U sensor_user sensor_data
for migration in ~/sensor/server/migrations/*.sql; do
  ~/pgsql/bin/psql -h 127.0.0.1 -p 5433 -U sensor_user -d sensor_data -f "$migration"
done

# Rust toolchain and API binary
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. ~/.cargo/env
cd ~/sensor/server && cargo build --release --locked

# Caddy
mkdir -p ~/caddy
curl -L -o /tmp/caddy.tar.gz \
  https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz
tar -xzf /tmp/caddy.tar.gz -C ~/caddy caddy
```

Install the three user units from `deploy/systemd/` and start them in order:

```bash
systemctl --user enable --now sensor-postgres sensor-server sensor-caddy
```

Caddy listens on `127.0.0.1:8080`; the `sensor-tunnel` service forwards
`sensor.boxcube.xyz` to it. No sudo and no inbound ports are required.

## Updating

After pulling new code, apply any new SQL before restarting the API:

```bash
for migration in ~/sensor/server/migrations/*.sql; do
  ~/pgsql/bin/psql -h 127.0.0.1 -p 5433 -U sensor_user -d sensor_data -f "$migration"
done
cd ~/sensor/server && cargo build --release --locked
systemctl --user restart sensor-server
```

For browser push alerts, add these to `~/sensor/server/.env` before the
restart (generate the pair with `pnpm vapid:keys` from a checkout):

```bash
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

The server loads that file through `EnvironmentFile=` in
`deploy/systemd/sensor-server.service`.

## Time

Postgres stores UTC. The API returns naive UTC timestamps with no offset. The
dashboard appends `Z` and renders times in the viewer's device timezone,
falling back to **`Asia/Shanghai`** (`DEFAULT_TIME_ZONE` in
`server/assets/script.js`) when the browser does not report one.

Ingestion does not depend on the database session timezone: it writes
`now() AT TIME ZONE 'UTC'` explicitly and the column default is
`CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`. The deployment's default timezone is
`Asia/Shanghai` (`TZ` on the systemd units and containers, plus the database
and role below), which only affects how values look in `psql` and in the logs:

```sql
ALTER DATABASE sensor_data SET timezone TO 'Asia/Shanghai';
ALTER ROLE sensor_user SET timezone TO 'Asia/Shanghai';
```

Rows written before that fix on a non-UTC host hold local wall-clock time and
read 8 h off in `Asia/Shanghai`. Repair them once with:

```sql
SET TimeZone = 'Asia/Shanghai';  -- the zone the rows were written in
UPDATE readings
SET timestamp = (timestamp AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
```

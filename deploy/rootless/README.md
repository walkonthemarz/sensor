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
| API binary | `~/sensor/server/target/release/sensor_server` |
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
~/pgsql/bin/psql -h 127.0.0.1 -p 5433 -U sensor_user -d sensor_data \
  -f ~/sensor/server/migrations/20241204153819_create_readings_table.sql

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

## Time

Postgres stores UTC. The API returns naive UTC timestamps; the dashboard appends
`Z` and renders them in the viewer's timezone. Keep the database and role at UTC
so all rows, the API, and the dashboard agree:

```sql
ALTER DATABASE sensor_data SET timezone TO 'UTC';
ALTER ROLE sensor_user SET timezone TO 'UTC';
```

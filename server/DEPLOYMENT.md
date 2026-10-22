# Deployment

## Topology

```
Internet
   │  HTTPS (Cloudflare edge certificate)
   ▼
Cloudflare Tunnel: sensor.boxcube.xyz
   │  http://127.0.0.1:8080
   ▼
Caddy (Docker)
   │  http://sensor-server:3000
   ▼
sensor-server ──▶ PostgreSQL (Docker volume)
```

The tunnel is the public ingress and owns the trusted HTTPS certificate. Caddy is
the local reverse proxy. No inbound ports need to be opened on the VPS.

The stack is defined in [docker-compose.yml](docker-compose.yml). There is no
Traefik and no host-level nginx dependency.

## 1. Server

On `boxcube.xyz`:

```bash
cd ~/sensor/server
cp .env.example .env
chmod 600 .env
# Set POSTGRES_PASSWORD and SENSOR_API_KEY in .env
docker compose up -d --build
docker compose ps
```

The API is now on `127.0.0.1:8080` (Caddy). Check it locally:

```bash
curl -fsS http://127.0.0.1:8080/api/readings
```

If `docker` returns a permission error, add the deploy user to the docker group
once and reconnect:

```bash
sudo usermod -aG docker kenny
```

## 2. Cloudflare Tunnel

The tunnel is created once, on the VPS, as the deploy user:

```bash
cloudflared tunnel create sensor
cloudflared tunnel route dns sensor sensor.boxcube.xyz
```

Copy [cloudflared/config.example.yml](../deploy/cloudflared/config.example.yml)
to `~/.cloudflared/sensor.yml`, replace the UUID, then install the user unit:

```bash
cp ../deploy/systemd/sensor-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sensor-tunnel
systemctl --user status sensor-tunnel
```

Verify from anywhere:

```bash
curl -fsS https://sensor.boxcube.xyz/api/readings
```

## 3. Client

On the machine with the M701 plugged in (`pc.boxcube.xyz`):

```bash
cd ~/sensor/client
cargo build --release
printf 'SENSOR_API_KEY=%s\n' '<the same key>' > .env
chmod 600 .env
```

Install [sensor-client.service](../deploy/systemd/sensor-client.service) under
`~/.config/systemd/user/`, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now sensor-client
journalctl --user -u sensor-client -f
```

The service runs:

```bash
./target/release/sensor_reader --port /dev/ttyACM0 \
  --server-url https://sensor.boxcube.xyz/api/readings
```

## Operations

```bash
docker compose logs -f sensor-server
docker compose logs -f caddy
docker compose ps
```

- Migrations run automatically from `docker-entrypoint.sh`.
- PostgreSQL data lives in the `postgres_data` volume.
- The API key is required for every POST. Rotate it by updating `server/.env` and
  `client/.env`, then restarting both services.

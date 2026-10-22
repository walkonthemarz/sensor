# Deployment

Two hosts, one private network path:

| Host | Role |
| :--- | :--- |
| `boxcube.xyz` | Docker Compose: PostgreSQL, Axum API, Caddy |
| `pc.boxcube.xyz` | Rust serial reader on `/dev/ttyACM0` |

Public HTTPS: **https://sensor.boxcube.xyz** via Cloudflare Tunnel.

## 1. Server

```bash
# on boxcube.xyz
cd ~/sensor/server
cp .env.example .env
chmod 600 .env
openssl rand -hex 32   # put this in SENSOR_API_KEY
openssl rand -hex 24   # put this in POSTGRES_PASSWORD
docker compose up -d --build
docker compose ps
```

Caddy listens on `127.0.0.1:8080`. The tunnel forwards to it.

If Docker reports a socket permission error:

```bash
sudo usermod -aG docker kenny
# reconnect, then retry
```

## 2. Cloudflare Tunnel

```bash
cloudflared tunnel create sensor
cloudflared tunnel route dns sensor sensor.boxcube.xyz
```

Copy [cloudflared/config.example.yml](cloudflared/config.example.yml) to
`~/.cloudflared/sensor.yml` and substitute the tunnel UUID. Install the unit:

```bash
cp deploy/systemd/sensor-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sensor-tunnel
```

The public certificate is issued and renewed by Cloudflare. Ports 80/443 do not
need to be open on the host.

## 3. Client

```bash
# on pc.boxcube.xyz
cd ~/sensor/client
cargo build --release
printf 'SENSOR_API_KEY=%s\n' '<same key as server>' > .env
chmod 600 .env
cp ../deploy/systemd/sensor-client.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sensor-client
journalctl --user -u sensor-client -f
```

The device is `/dev/ttyACM0` (CH343 USB serial). The user must be in the
`dialout` group.

## Verify

```bash
curl -fsS https://sensor.boxcube.xyz/api/readings
curl -fsS -X POST https://sensor.boxcube.xyz/api/readings \
  -H 'content-type: application/json' \
  -H "x-api-key: $SENSOR_API_KEY" \
  -d '{"eco2":700,"ech2o":20,"tvoc":100,"pm2_5":5,"pm10":8,"temperature":22.5,"humidity":45}'
```

Then open https://sensor.boxcube.xyz.

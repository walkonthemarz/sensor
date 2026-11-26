---
name: deploy-to-server
description: Build sensor_server on a workstation and ship the release binary to the host that runs it. Use when deploying the API after a server change, when asked how deployment works, or when a deploy needs to be rolled back.
---

# Deploy `sensor_server` to the server

The production host runs the API binary only. It does **not** keep a cargo build
tree: `target/` once held 7.1 G of a 43 G disk while the live binary is 12 M.
Build on a workstation, copy the binary over, restart the unit.

## Topology

```
workstation  --cargo build-->  target/release/sensor_server
     │
     │  ssh (alias from ~/.ssh/config)
     ▼
server  ~/bin/sensor_server   <-- systemd --user unit (see deploy/systemd/)
        ~/bin/sensor_server.prev   (one generation, for rollback)
```

No host names, addresses, or user names belong in this repository — it is
public. Keep them in `~/.ssh/config` and pass them through environment
variables at call time.

## Recipe

`scripts/deploy-server.sh` performs these steps; read it before changing it.

1. **Build on the workstation** — `cargo build --release -p sensor_server`.
2. **glibc guard** — read the highest `GLIBC_x.y` symbol version the binary
   needs and compare it with the server's `ldd --version`. A workstation with a
   newer glibc produces binaries that abort on the server with
   `GLIBC_2.x not found`; the guard stops the deploy before it does damage.
   If it trips, build for `x86_64-unknown-linux-musl` instead (static, no glibc
   coupling) — note that `aws-lc-sys` and `libsqlite3-sys` in the dependency
   tree need a musl C toolchain for that.
3. **Upload** to a temporary name next to the target binary.
4. **Verify** the remote `sha256sum` matches the local one, then `chmod +x`.
5. **Swap atomically** — copy the current binary to `sensor_server.prev`, `mv`
   the upload into place, so a restart never sees a half-written file.
6. **Restart** the `systemd --user` unit.
7. **Health check** — poll the API over ssh on loopback until it answers.
8. **Roll back automatically** if the health check keeps failing: restore
   `.prev`, restart, report the state.

## Usage

```bash
# from a checkout on the workstation
DEPLOY_HOST=<ssh-alias> scripts/deploy-server.sh

# reuse the last build
DEPLOY_HOST=<ssh-alias> scripts/deploy-server.sh --no-build
```

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `DEPLOY_HOST` | *required* | ssh alias or `user@host` of the server |
| `DEPLOY_BIN` | `bin/sensor_server` | remote path of the binary (relative to `$HOME`) |
| `DEPLOY_UNIT` | `sensor-server` | `systemd --user` unit to restart |
| `DEPLOY_HEALTH` | `http://127.0.0.1:3000/api/readings` | URL polled **on the server** |
| `BUILD_PROXY` | *unset* | proxy for cargo when crates.io is unreachable |

The health check runs on the server on purpose: it verifies the process, the
database link and the port without depending on DNS, Cloudflare, or the
public hostname.

## Invariants

- **Never `cargo build` on the server.** It is the cheapest way to fill the disk
  and it changes nothing about correctness.
- **Never ship a binary built against a newer glibc than the server has.**
- **Keep `~/bin/sensor_server` stable.** `deploy/systemd/sensor-server.service`
  and `deploy/rootless/README.md` both pin that path.
- Assets (`*.png`, `*.woff2`, `*.pdf`, ...) are Git LFS pointers in the tree.
  A deploy copies only the binary, so a checkout without `git lfs pull` cannot
  serve the dashboard — run `git lfs pull` before touching `server/assets/`.

## Manual rollback

```bash
ssh "$DEPLOY_HOST" 'mv -f ~/bin/sensor_server.prev ~/bin/sensor_server \
  && systemctl --user restart sensor-server'
```

## Post-deploy checks

```bash
ssh "$DEPLOY_HOST" 'systemctl --user is-active sensor-postgres sensor-server sensor-caddy sensor-tunnel'
curl -s -o /dev/null -w '%{http_code}\n' https://<public-dashboard>/     # 200
```

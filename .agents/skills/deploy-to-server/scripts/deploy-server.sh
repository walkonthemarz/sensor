#!/usr/bin/env bash
#
# Build sensor_server on this machine and deploy the binary to the server.
# See ../SKILL.md for the workflow and the invariants this script enforces.
#
# Required:
#   DEPLOY_HOST   ssh alias / user@host of the server (keep it out of the repo)
#
# Optional:
#   DEPLOY_BIN    remote binary path, relative to $HOME   (default bin/sensor_server)
#   DEPLOY_UNIT   systemd --user unit to restart          (default sensor-server)
#   DEPLOY_HEALTH URL polled on the server until it answers
#                 (default http://127.0.0.1:3000/api/readings)
#   BUILD_PROXY   proxy for cargo, e.g. http://127.0.0.1:7890
#
# Usage:
#   DEPLOY_HOST=my-vps scripts/deploy-server.sh
#   DEPLOY_HOST=my-vps scripts/deploy-server.sh --no-build

set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:?set DEPLOY_HOST to the ssh alias of the server}"
DEPLOY_BIN="${DEPLOY_BIN:-bin/sensor_server}"
DEPLOY_UNIT="${DEPLOY_UNIT:-sensor-server}"
DEPLOY_HEALTH="${DEPLOY_HEALTH:-http://127.0.0.1:3000/api/readings}"
BUILD_PROXY="${BUILD_PROXY:-}"

build=1
case "${1:-}" in
  --no-build) build=0 ;;
  "") ;;
  *) echo "usage: $0 [--no-build]" >&2; exit 2 ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if (( build )); then
  echo "==> building sensor_server (release)"
  if [[ -n "$BUILD_PROXY" ]]; then
    export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY"
  fi
  cargo build --release -p sensor_server
fi

bin="$repo_root/target/release/sensor_server"
[[ -x "$bin" ]] || { echo "no binary at $bin" >&2; exit 1; }

# --- glibc guard -------------------------------------------------------------
# A workstation with a newer glibc than the server produces binaries that abort
# at load time. Compare what the binary needs with what the server provides.
need="$(objdump -T "$bin" | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' | sort -V | tail -1 | cut -d_ -f2)"
have="$(ssh "$DEPLOY_HOST" 'ldd --version | head -1 | grep -oE "[0-9]+\.[0-9]+$"')"
if [[ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | tail -1)" != "$have" ]]; then
  echo "abort: binary needs GLIBC_$need but the server has $have" >&2
  echo "       rebuild for x86_64-unknown-linux-musl (see ../SKILL.md)" >&2
  exit 1
fi
echo "==> glibc ok (binary needs $need, server has $have)"

# --- upload ------------------------------------------------------------------
sha="$(sha256sum "$bin" | cut -d' ' -f1)"
bin_dir="$(dirname "$DEPLOY_BIN")"
tmp="$bin_dir/.upload.$$"

echo "==> uploading $(du -h "$bin" | cut -f1) to $DEPLOY_HOST:$DEPLOY_BIN"
ssh "$DEPLOY_HOST" "mkdir -p '$bin_dir'"
scp -q -C "$bin" "$DEPLOY_HOST:$tmp"

# --- verify and swap ---------------------------------------------------------
ssh "$DEPLOY_HOST" "set -e
  got=\$(sha256sum '$tmp' | cut -d' ' -f1)
  if [ \"\$got\" != '$sha' ]; then
    rm -f '$tmp'
    echo 'checksum mismatch, nothing changed' >&2
    exit 1
  fi
  chmod +x '$tmp'
  [ -f '$DEPLOY_BIN' ] && cp -f '$DEPLOY_BIN' '$DEPLOY_BIN.prev'
  mv -f '$tmp' '$DEPLOY_BIN'
  systemctl --user restart '$DEPLOY_UNIT'
"

# --- health check ------------------------------------------------------------
echo "==> waiting for $DEPLOY_HEALTH on the server"
for _ in $(seq 1 20); do
  if ssh "$DEPLOY_HOST" "curl -fsS -o /dev/null -m 5 '$DEPLOY_HEALTH'"; then
    echo "ok  sha=${sha:0:12}  unit=$(ssh "$DEPLOY_HOST" "systemctl --user is-active '$DEPLOY_UNIT'")"
    exit 0
  fi
  sleep 2
done

echo "health check failed, rolling back" >&2
ssh "$DEPLOY_HOST" "set -e
  if [ -f '$DEPLOY_BIN.prev' ]; then
    mv -f '$DEPLOY_BIN.prev' '$DEPLOY_BIN'
    systemctl --user restart '$DEPLOY_UNIT'
    echo 'restored the previous binary' >&2
  else
    echo 'no previous binary to restore' >&2
  fi"
exit 1

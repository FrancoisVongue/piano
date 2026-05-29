#!/usr/bin/env bash
# Build and run piano-daemon under sudo, replacing this shell so Tilt's
# signals reach the daemon directly. Called from the Tiltfile; safe to
# invoke manually for daemon-only debugging.
set -euo pipefail

cd "$(dirname "$0")/.."

# Pull PIANO_DAEMON_TOKEN (and any other daemon-relevant vars) from .env
# so the script is self-sufficient outside Tilt too.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${PIANO_DAEMON_TOKEN:-}" ]]; then
  echo "PIANO_DAEMON_TOKEN is not set — run ./scripts/generate-secrets.sh first." >&2
  exit 1
fi

# Build (Go's incremental compile is fast; this is a no-op on rebuild).
( cd daemon && go build -o /tmp/piano-daemon . )

# Kill any leftover daemon from a prior Tilt run that outlived its parent
# (sudo doesn't always forward SIGINT/TERM, so Ctrl-C of Tilt can orphan
# the daemon and keep ports 9718/2200 bound). Match by exact process
# name (-x) — not -f / cmdline — because -f would also match this very
# shell since the daemon path appears in its argv.
sudo pkill -9 -x piano-daemon 2>/dev/null || true
sleep 0.3

# Capture absolute paths BEFORE the cd — daemon reads Containerfile.machine
# and env/packages.txt relative to its own CWD, so it must run from daemon/.
PROJECT_ROOT="$PWD"
cd daemon

# exec sudo so signals from Tilt → daemon have no intermediate hops.
exec sudo -E \
  PIANO_USER_NAME="$USER" \
  PIANO_USER_HOME="$HOME" \
  PIANO_USER_UID="$(id -u)" \
  PIANO_USER_GID="$(id -g)" \
  /tmp/piano-daemon \
    --port 9718 \
    --layers-dir "/var/tmp/piano/$(id -u)" \
    --backend-url ws://localhost:3031/api/daemon/ws \
    --token "$PIANO_DAEMON_TOKEN" \
    --sish-host localhost \
    --sish-port 22000 \
    --ssh-gateway-port 2200 \
    --sish-pubkey-dest "$PROJECT_ROOT/sish/pubkeys/daemon.pub"

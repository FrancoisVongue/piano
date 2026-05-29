#!/usr/bin/env bash
# Piano — one-shot setup for a fresh Linux machine.
#
# Installs every dependency, generates secrets, and tells you what to run next.
# Idempotent: re-running is safe; already-installed tools are skipped.
#
# macOS: this script does not run on Darwin — Piano's daemon needs Linux
# kernel features (overlayfs, BTRFS, cgroup-freezer). On a Mac, install
# OrbStack, create an Ubuntu VM, and run this script inside the VM:
#
#   brew install orbstack
#   orb create ubuntu piano && orb shell piano
#   git clone https://github.com/FrancoisVongue/piano.git && cd piano
#   ./scripts/install.sh
#
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: $(uname -s) is not supported."
  echo "Run this inside a Linux VM (OrbStack on macOS). See README.md."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "Error: this installer assumes apt-get (Debian / Ubuntu)."
  echo "On other distros, install the deps manually:"
  echo "  docker (with compose), tilt, go, podman, crun, fuse-overlayfs, uidmap, btrfs-progs"
  echo "Then run: ./scripts/generate-secrets.sh && tilt up"
  exit 1
fi

cd "$(dirname "$0")/.."

have() { command -v "$1" >/dev/null 2>&1; }
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# ── Docker (with compose plugin) ─────────────────────────────────────────────
if ! have docker; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# Ensure user is in the docker group (always — handles fresh install AND
# the case where docker was pre-installed but user wasn't added).
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  log "Adding $USER to the docker group..."
  sudo usermod -aG docker "$USER"
  NEED_RELOGIN=1
fi

# ── Tilt ─────────────────────────────────────────────────────────────────────
if ! have tilt; then
  log "Installing Tilt..."
  curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash
fi

# ── Go + daemon runtime deps (podman, overlayfs, btrfs, etc.) ───────────────
APT_PKGS=()
have go               || APT_PKGS+=(golang-go)
have podman           || APT_PKGS+=(podman)
have crun             || APT_PKGS+=(crun)
have fuse-overlayfs   || APT_PKGS+=(fuse-overlayfs)
have newuidmap        || APT_PKGS+=(uidmap)
have mkfs.btrfs       || APT_PKGS+=(btrfs-progs)

if [[ ${#APT_PKGS[@]} -gt 0 ]]; then
  log "Installing apt packages: ${APT_PKGS[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${APT_PKGS[@]}"
fi

# ── Secrets (.env) ───────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  log "Generating .env with random secrets..."
  ./scripts/generate-secrets.sh
else
  log ".env already exists — keeping it. (Delete to regenerate.)"
fi

# ── Sish pubkey dir (daemon writes its key here; sish container reads it) ───
mkdir -p sish/pubkeys sish/keys

# ── Verify passwordless sudo (the daemon runs as root via sudo inside Tilt) ─
# `sudo -n true` succeeds iff NOPASSWD is configured for this user — the
# real contract we need. Warming the credential cache (`sudo -v`) is
# useless: cache expires in 15 min and Tilt restarts the daemon past
# that window, so it would only delay the failure.
log "Checking passwordless sudo (required by the daemon)..."
if ! sudo -n true 2>/dev/null; then
  echo
  echo "✗ Passwordless sudo is not configured for $USER."
  echo "  Add a rule as root (e.g. via 'su -' or another sudo-capable user):"
  echo
  echo "    echo \"$USER ALL=(ALL) NOPASSWD: ALL\" > /etc/sudoers.d/piano-nopasswd"
  echo "    chmod 440 /etc/sudoers.d/piano-nopasswd"
  echo
  echo "  Then re-run this script."
  exit 1
fi

echo
echo "✓ Setup complete."
echo
if [[ -n "${NEED_RELOGIN:-}" ]]; then
  echo "  ⚠ You were just added to the docker group. Refresh your shell first:"
  echo "      sudo su - $USER"
  echo "    (or log out and back in.) Then continue with the steps below."
  echo
fi
echo "  Start everything:    tilt up"
echo "  Tilt UI:             http://localhost:10350"
echo "  Piano:               http://localhost:3009"
echo
echo "  Stop everything:     tilt down"

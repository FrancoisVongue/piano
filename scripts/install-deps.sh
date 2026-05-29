#!/bin/bash
# Installs project runtime deps: direnv + go. Idempotent.
set -e

log()  { echo "[✓] $1"; }
warn() { echo "[!] $1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# direnv
if have direnv; then
  warn "direnv already installed ($(direnv --version))"
else
  log "Installing direnv..."
  sudo apt-get update -qq && sudo apt-get install -y direnv
fi

# go
if ! have go && [ ! -x /usr/local/go/bin/go ]; then
  log "Installing Go 1.23.4..."
  ARCH=amd64; [ "$(uname -m)" = "aarch64" ] && ARCH=arm64
  curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go1.23.4.linux-${ARCH}.tar.gz"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf /tmp/go.tgz
  rm /tmp/go.tgz
else
  warn "Go already installed"
fi

# Ensure Go on PATH in ~/.zshrc and ~/.bashrc
LINE='export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"  # piano: go'
for rc in ~/.zshrc ~/.bashrc; do
  [ -f "$rc" ] || continue
  grep -qF "# piano: go" "$rc" || echo "$LINE" >> "$rc"
done

log "Done. Run 'source ~/.zshrc' (or open new shell)."

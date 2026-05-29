#!/bin/bash
# Full dev-machine setup: system update + install missing tools + write ~/.zshrc.
# Run once on a fresh machine. For lighter runs use:
#   just machine-update   — only apt update/upgrade + common tools
#   just machine-sync     — only install missing dev tools (no zshrc)
set -e

DIR="$(dirname "$0")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }

echo "🚀 Ultimate Dev Machine Setup Script"
echo "===================================="

log "Step 1/3: system update"
bash "$DIR/machine-update.sh"

echo ""
log "Step 2/3: install missing dev tools"
bash "$DIR/machine-sync.sh"

echo ""
log "Step 3/3: write ~/.zshrc"
bash "$DIR/machine-zshrc.sh"

echo ""
echo "=================================="
log "Setup complete! 🎉"
warn "IMPORTANT: Please run 'exec zsh' or restart your terminal!"
warn "If you're in SSH, you might need to reconnect for Docker group changes."
log "Then you can start any project with: just setup && just dev"

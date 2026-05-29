#!/bin/bash
# Checks each required dev tool and installs only the missing ones.
# Does NOT touch ~/.zshrc and does NOT run apt update/upgrade.
# Idempotent — safe to run any time.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
check_command() { command -v "$1" >/dev/null 2>&1; }
check_mise_tool() { mise which "$1" >/dev/null 2>&1; }

echo "🔧 Dev Machine — sync missing tools"
echo "===================================="

# Docker
if check_command docker; then
    warn "Docker already installed, skipping..."
else
    log "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    log "Docker installed! (You'll need to log out/in for group changes)"
fi

# Zsh & Oh My Zsh
if check_command zsh; then
    warn "Zsh already installed, skipping..."
else
    log "Installing Zsh..."
    sudo apt install -y zsh
fi

if [ -d "$HOME/.oh-my-zsh" ]; then
    warn "Oh My Zsh already installed, skipping..."
else
    log "Installing Oh My Zsh..."
    RUNZSH=no sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

    log "Installing Zsh plugins..."
    git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions 2>/dev/null || true
    git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting 2>/dev/null || true
fi

# mise (manages project tool versions from .mise.toml — bun, node, tilt, go, pnpm, terraform, caddy, jq)
if check_command mise; then
    warn "mise already installed, skipping..."
else
    log "Installing mise..."
    curl https://mise.run | sh
fi

# Ensure mise + its shims are on PATH for the rest of this script.
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"

cd "$PROJECT_ROOT"
log "Installing project tools via mise (.mise.toml)..."
mise trust >/dev/null 2>&1 || true
mise install
mise reshim >/dev/null 2>&1 || true

# Neovim
if check_command nvim; then
    warn "Neovim already installed, skipping..."
else
    log "Installing Neovim..."
    sudo add-apt-repository -y ppa:neovim-ppa/stable
    sudo apt update -qq
    sudo apt install -y neovim
fi

# Zellij
if check_command zellij; then
    warn "Zellij already installed, skipping..."
else
    log "Installing Zellij..."
    curl -L https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz | tar xz
    sudo mv zellij /usr/local/bin/
fi

# Just
if check_command just; then
    warn "Just already installed, skipping..."
else
    log "Installing Just..."
    curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to ~/.local/bin
    mkdir -p ~/.local/bin
    export PATH="$HOME/.local/bin:$PATH"
fi

# GitHub CLI (gh)
if check_command gh; then
    warn "gh already installed, skipping..."
else
    log "Installing GitHub CLI..."
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
        sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
        sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update -qq && sudo apt-get install -y gh
fi

# Google Cloud SDK (gcloud)
# Not managed via mise: SDK is large (~200MB+), pulls Python deps and components
# (gke-gcloud-auth-plugin, kubectl, bq, etc.) that don't play well with version managers.
if check_command gcloud; then
    warn "gcloud already installed, skipping..."
else
    log "Installing Google Cloud SDK..."
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | \
        sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | \
        sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list >/dev/null
    sudo apt-get update -qq && sudo apt-get install -y google-cloud-cli
fi

# direnv
if check_command direnv; then
    warn "direnv already installed, skipping..."
else
    log "Installing direnv..."
    sudo apt install -y direnv
fi

# Go
if check_command go; then
    warn "Go already installed ($(go version)), skipping..."
else
    log "Installing Go..."
    GO_VERSION="1.23.4"
    GO_ARCH="amd64"
    case "$(uname -m)" in
        aarch64|arm64) GO_ARCH="arm64" ;;
    esac
    GO_TARBALL="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
    curl -fsSL -o "/tmp/${GO_TARBALL}" "https://go.dev/dl/${GO_TARBALL}"
    sudo rm -rf /usr/local/go
    sudo tar -C /usr/local -xzf "/tmp/${GO_TARBALL}"
    rm -f "/tmp/${GO_TARBALL}"
    export PATH="/usr/local/go/bin:$PATH"
fi

# Just completions for Oh My Zsh
if [ -f ~/.oh-my-zsh/custom/completions/_just ]; then
    warn "Just completions already setup, skipping..."
else
    log "Setting up Just completions..."
    mkdir -p ~/.oh-my-zsh/custom/completions
    just --completions zsh > ~/.oh-my-zsh/custom/completions/_just 2>/dev/null || true
fi

echo ""
echo "=================================="
log "Sync complete!"
echo ""
echo "Installed:"
check_command docker && echo "  ✓ Docker" || echo "  ✗ Docker (failed)"
check_command zsh && echo "  ✓ Zsh" || echo "  ✗ Zsh (failed)"
check_command nvim && echo "  ✓ Neovim" || echo "  ✗ Neovim (failed)"
check_command zellij && echo "  ✓ Zellij" || echo "  ✗ Zellij (failed)"
check_command just && echo "  ✓ Just" || echo "  ✗ Just (failed)"
check_command mise && echo "  ✓ mise" || echo "  ✗ mise (failed)"
check_mise_tool bun && echo "  ✓ Bun (via mise)" || echo "  ✗ Bun (failed)"
check_mise_tool node && echo "  ✓ Node (via mise)" || echo "  ✗ Node (failed)"
check_mise_tool pnpm && echo "  ✓ pnpm (via mise)" || echo "  ✗ pnpm (failed)"
check_mise_tool tilt && echo "  ✓ Tilt (via mise)" || echo "  ✗ Tilt (failed)"
check_mise_tool terraform && echo "  ✓ Terraform (via mise)" || echo "  ✗ Terraform (failed)"
check_mise_tool caddy && echo "  ✓ Caddy (via mise)" || echo "  ✗ Caddy (failed)"
check_mise_tool jq && echo "  ✓ jq (via mise)" || echo "  ✗ jq (failed)"
check_command gh && echo "  ✓ gh" || echo "  ✗ gh (failed)"
check_command gcloud && echo "  ✓ gcloud" || echo "  ✗ gcloud (failed)"
check_command direnv && echo "  ✓ direnv" || echo "  ✗ direnv (failed)"
(check_mise_tool go || check_command go || [ -x /usr/local/go/bin/go ]) && echo "  ✓ Go" || echo "  ✗ Go (failed)"

if ! grep -qsE 'mise activate|mise/shims' "$HOME/.zshrc"; then
    echo ""
    warn 'mise tools are installed, but this script does not edit ~/.zshrc.'
    warn 'If caddy is missing after the script exits, run: eval "$(mise activate zsh)"'
fi

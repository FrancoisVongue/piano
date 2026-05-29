#!/bin/bash
# Writes the project's standard ~/.zshrc (backs up the existing one).
# Called by machine.sh during the initial full setup.
set -e

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[✓]${NC} $1"; }

if [ -f ~/.zshrc ]; then
    cp ~/.zshrc ~/.zshrc.backup.$(date +%Y%m%d_%H%M%S)
    log "Backed up existing .zshrc"
fi

log "Writing .zshrc configuration..."
cat > ~/.zshrc << 'ZSHRC'
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="kphoen"

# Local bin (Just, mise, and other tools)
export PATH="$HOME/.local/bin:$PATH"

# mise (manages bun, node, tilt, pnpm, terraform, caddy, jq via .mise.toml)
command -v mise >/dev/null 2>&1 && eval "$(mise activate zsh)"

# Go (manual install — not managed by mise here)
export PATH="/usr/local/go/bin:$PATH"
export PATH="$HOME/go/bin:$PATH"

# direnv
command -v direnv >/dev/null 2>&1 && eval "$(direnv hook zsh)"

# PLUGINS
plugins=(
  sudo
  history
  git
  docker
  docker-compose
  zsh-autosuggestions
  zsh-syntax-highlighting
)

# Load Oh My Zsh
source $ZSH/oh-my-zsh.sh

# ALIASES
alias gl="git log --graph --abbrev-commit --decorate --format=format:'%C(bold blue)%h%C(reset) - %C(bold green)(%ar)%C(reset) %C(white)%s%C(reset) %C(dim white)- %an%C(reset)%C(bold yellow)%d%C(reset)'"
alias glb='git reflog show --date=local --all | grep -o "checkout: moving from .\\+ to \\S\\+" | awk '\''{print $NF}'\'' | awk '\''!seen[$0]++'\'' | head -n 10'
alias gco="git checkout"
alias gmc="git branch --merged | egrep -v \"(^\*|master|main|dev)\" | xargs git branch -d"
alias ls="ls -lha --color=auto"
alias vim="nvim"
alias python="python3"
alias kc="kubectl"
alias j="just"
ZSHRC

log ".zshrc written."

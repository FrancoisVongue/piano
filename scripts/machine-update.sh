#!/bin/bash
# Updates system packages and installs common CLI utilities.
# Idempotent. Safe to run often (unlike machine.sh which sets up the full dev stack).
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }

log "Updating apt index..."
sudo apt-get update -qq

log "Upgrading installed packages..."
sudo apt-get upgrade -y

log "Installing common tools..."
sudo apt-get install -y htop curl git vim wget unzip build-essential software-properties-common

log "Done."

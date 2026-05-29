#!/bin/bash
set -e

echo "=== Piano Daemon — Host Setup ==="
echo ""

# Prerequisites: podman, Go (build only).
# Docker is NOT required and NOT used.
# Daemon runs as root (sudo) for kernel overlay + rootful containers.

if ! command -v podman &> /dev/null; then
    echo "Installing podman..."
    sudo apt-get update && sudo apt-get install -y podman crun
else
    echo "podman: $(podman --version)"
fi

if ! command -v go &> /dev/null; then
    echo "Go not found. Install from https://go.dev/dl/"
    exit 1
else
    echo "go: $(go version)"
fi

echo ""
echo "Building daemon..."
cd "$(dirname "$0")"
go build -o piano-daemon .
echo "Built: ./piano-daemon"

echo ""
echo "=== Run ==="
echo ""
echo "Standalone (primary):"
echo "  sudo PIANO_USER_NAME=\$USER PIANO_USER_HOME=\$HOME PIANO_USER_UID=\$(id -u) PIANO_USER_GID=\$(id -g) \\"
echo "    ./piano-daemon --backend-url ws://your-backend:PORT/api/daemon/ws"
echo ""
echo "With Tilt (full monorepo dev only — requires the Piano repo and \`just dev\`):"
echo "  just dev"
echo ""
echo "=== Inside machines ==="
echo ""
echo "  whoami              → your username (not root)"
echo "  sudo apt install X  → works (NOPASSWD)"
echo "  podman run postgres → works (kernel overlay, fast)"
echo "  docker run redis    → works (alias for podman)"
echo "  docker compose up   → works (real docker-compose v2)"
echo "  Scratch images      → work (nats:latest, etc)"
echo ""
echo "Host Docker daemon is NOT accessible from inside machines."

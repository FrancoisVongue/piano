# Loads .env.local so port vars are available as $BACKEND_PORT, etc.
set dotenv-path := ".env.local"

# Show available commands
default:
  @just --list

# ======= Setup scripts
# Full dev-machine setup: update + sync + write ~/.zshrc. Long, run once.
machine:
  @echo "🚀 Setting up your machine..."
  @bash ./scripts/machine.sh

# Only apt update + upgrade + common CLI tools. Fast, idempotent.
machine-update:
  @echo "🔄 Updating system packages..."
  @bash ./scripts/machine-update.sh

# Only check & install missing dev tools (Docker, Bun, Go, gcloud, gh, ...). No zshrc changes.
machine-sync:
  @echo "� Syncing dev tools..."
  @bash ./scripts/machine-sync.sh

# Install project runtime deps (direnv, go)
deps:
  @echo "📦 Installing project dependencies (direnv, go)..."
  @bash ./scripts/install-deps.sh

# Setup everything
setup:
  @echo "🚀 Setting up your startup..."
  @bash ./scripts/install-deps.sh
  bun install
  @echo "✅ Ready to rock!"







# ======= Development
dev:
  @echo "🔥 Starting Tilt on port ${TILT_PORT:-10358}..."
  tilt up --port ${TILT_PORT:-10358}

# Stop everything
down:
  tilt down

restart:
  @just down
  @just dev

# ======= Multi-instance port management
# Set ports for dev slot N (0–4). Each slot shifts all ports by N×10 so
# multiple instances can coexist on the same machine. Slot 0 = defaults.
#
#   just ports 0    ← reset to defaults
#   just ports 2    ← third instance (+20 on every port)
#
# Under the hood: writes SLOT in .envrc, runs `direnv allow` which
# recomputes every port + URL + regenerates .env.local.
ports slot="0":
  #!/usr/bin/env bash
  sed -i 's/^SLOT=.*/SLOT={{slot}}/' .envrc
  direnv allow .
  direnv exec . true
  echo ""
  echo "  Slot set to {{slot}}. Ports:"
  grep -E '^[A-Z_]+_PORT=' .env.local | sort | sed 's/^/    /'
  echo ""
  echo "  Run 'just dev' to start."

# Show the current dev-port mapping
ports-show:
  @grep -E '^[A-Z_]+_PORT=' .env.local | sort


# ======= Edge host (only matters when running Piano nested inside Piano)
# Browser cookies are scoped per-host. When you run an inner Piano in a
# Piano-machine on the same browser as the outer one, both on localhost
# = cookie collisions. Mapping a separate /etc/hosts name for the inner
# instance gives clean cookie isolation.
#
#   just host-piano        ← inner instance, uses piano.com:CADDY_PORT
#   just host-localhost    ← default, uses localhost:CADDY_PORT
#
# Make sure /etc/hosts has `127.0.0.1 piano.com` first.

host-piano:
  echo 'export EDGE_HOST=piano.com' > .envrc.local
  direnv allow .
  @echo "  EDGE_HOST=piano.com → http://piano.com:$(grep '^CADDY_PORT=' .env.local | cut -d= -f2)"
  @echo "  Restart Tilt to pick up new URLs."

host-localhost:
  rm -f .envrc.local
  direnv allow .
  @echo "  EDGE_HOST=localhost → http://localhost:$(grep '^CADDY_PORT=' .env.local | cut -d= -f2)"
  @echo "  Restart Tilt to pick up new URLs."

host-show:
  @echo "  EDGE_URL = $(grep '^EDGE_URL=' .env.local | cut -d= -f2-)"






#  ========= Database 
db-migrate:
  bun run db:migrate

db-studio:
  cd backend && bun run db:studio

db-migrate-dev name="":
  cd backend && bun run migrate:dev --name {{name}}

# Quick push without migration file (for prototyping)
db-push:
  cd backend && bun run db:push

# Snapshot current DB (excludes sensitive tables). Optional: just dbdump my-feature
dbdump name="":
  @bash ./scripts/db-snapshot.sh {{name}}

# Restore DB from snapshot. Auto-backs up current state first.
dbload name:
  @bash ./scripts/db-restore.sh {{name}}





# Logs
logs service="all":
  #!/usr/bin/env bash
  if [ "{{service}}" = "all" ]; then
    tilt logs -f
  else
    tilt logs -f {{service}}
  fi

# Clean
clean:
  tilt down
  docker system prune -af
  bun run clean

# Quick check
check:
  @echo "Checking environment..."
  @which bun > /dev/null && echo "✅ Bun installed"
  @which tilt > /dev/null && echo "✅ Tilt installed"  
  @which just > /dev/null && echo "✅ Just installed"
  @which docker > /dev/null && echo "✅ Docker installed"
  @which direnv > /dev/null && echo "✅ direnv installed"
  @which go > /dev/null && echo "✅ Go installed"

# ========= Context concat (for AI consumption)
# Six primitives; chain them as needed, e.g. `just cat-backend cat-shared cat-config`.
#
#   cat-config          every package.json, tsconfig, lint/build/framework config
#   cat-devops          Justfile, Tiltfile, mise, envrc, Dockerfiles, compose, CI, hooks, scripts, terraform
#   cat-backend         backend/**/*.ts + prisma schema
#   cat-daemon          daemon/**/*.go + go.mod/go.sum
#   cat-shared          shared/src/**/*.ts
#   cat-frontend        frontend/src ts/tsx + globals.css
#   cat-frontend-short  frontend minus components/ui, tests, stories, css

cat-config:
  @bash ./scripts/concat-config.sh

cat-devops:
  @bash ./scripts/concat-devops.sh

cat-backend:
  @bash ./scripts/concat-backend.sh

cat-daemon:
  @bash ./scripts/concat-daemon.sh

cat-shared:
  @bash ./scripts/concat-shared.sh

cat-frontend:
  @bash ./scripts/concat-frontend.sh

cat-frontend-short:
  @bash ./scripts/concat-frontend-short.sh


# Kitchen sink
cat-all:
  @just cat-config
  @just cat-devops
  @just cat-backend
  @just cat-daemon
  @just cat-shared
  @just cat-frontend


# ======= CLI =======
# Build the piano CLI (single static binary) into piano-cli/bin/piano.
cli-build:
  @cd piano-cli && go build -o bin/piano .
  @echo "Built piano-cli/bin/piano"

# Build + install piano to ~/.local/bin (already on PATH per machine-zshrc.sh).
cli-install:
  @mkdir -p $HOME/.local/bin
  @cd piano-cli && go build -o $HOME/.local/bin/piano .
  @echo "Installed: $HOME/.local/bin/piano"
  @piano --help >/dev/null && echo "Run 'piano --help' to get started."

# Typecheck-equivalent for the CLI.
cli-check:
  @cd piano-cli && go vet ./... && go build ./...

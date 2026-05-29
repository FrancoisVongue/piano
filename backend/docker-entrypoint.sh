#!/bin/sh
set -e

# Run migrations before starting. Prisma migrate deploy is idempotent and uses
# advisory locks — safe to call concurrently from backend + temporal-worker.
pnpm prisma migrate deploy

exec "$@"

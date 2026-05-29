# backend/Dockerfile
# Full Debian-based node image (not slim/alpine) — includes openssl, ca-certs,
# and other userland tools Prisma / Temporal SDK expect. Image size is not the
# bottleneck; "it just works" is.
FROM node:22
WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
# frontend/package.json is required for frozen-lockfile validation,
# but its deps are skipped by the --filter below.
COPY frontend/package.json ./frontend/
COPY backend/prisma ./backend/prisma

# --filter restricts install to backend + shared (and their transitive deps).
# Frontend deps are skipped → smaller image, faster install.
RUN pnpm install --frozen-lockfile --filter piano-backend --filter @piano/shared

COPY shared ./shared
COPY backend ./backend

# Generate Prisma client at build time
RUN cd /app/backend && pnpm prisma generate

COPY backend/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /app/backend
EXPOSE 3031
ENTRYPOINT ["entrypoint.sh"]
CMD ["pnpm", "start"]
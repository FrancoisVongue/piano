# frontend/Dockerfile
FROM node:22 AS builder
WORKDIR /app

# Устанавливаем pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Копируем зависимости
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

# Устанавливаем только frontend и shared зависимости
RUN pnpm install --frozen-lockfile --filter frontend --filter @piano/shared

# Копируем код
COPY shared ./shared
COPY frontend ./frontend

WORKDIR /app/frontend
# Отключаем телеметрию Next.js для скорости билда
ENV NEXT_TELEMETRY_DISABLED=1

# ВАЖНО: Next.js "запекает" переменные окружения во время билда.
# Для Cloud Run нам придется либо пересобирать образ для каждого энва,
# либо использовать publicRuntimeConfig (устарело), 
# либо просто передавать ARG во время билда.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN pnpm run build

# --- Runner Stage ---
FROM node:22 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Копируем standalone сборку
COPY --from=builder /app/frontend/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/frontend/.next/static ./frontend/.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "frontend/server.js"]